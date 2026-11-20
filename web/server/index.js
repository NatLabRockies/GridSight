/**
 * Meridian – Bun API Server
 *
 * Responsibilities:
 *  1. Cookie-based session auth (login / logout / session-check)
 *  2. Authenticated reverse-proxy to the Python backend
 *  3. Static-asset serving from ../dist (production)
 *
 * Environment variables (see .env.example):
 *   ADMIN_USER, ADMIN_PASS, SESSION_SECRET,
 *   BACKEND_URL, API_KEY, BUN_PORT
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, openSync, writeSync, closeSync, ftruncateSync } from "node:fs";
import { unlink } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ADMIN_USER = process.env.ADMIN_USER ?? "admin";
const ADMIN_PASS = process.env.ADMIN_PASS ?? "changeme";
const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-secret-change-me";
const BACKEND_URL = (
  process.env.BACKEND_URL ?? "http://127.0.0.1:5001"
).replace(/\/$/, "");
const API_KEY = process.env.API_KEY ?? "";
const PORT = parseInt(process.env.BUN_PORT ?? "3001", 10);
const IS_PROD = process.env.NODE_ENV === "production";
// SECURE_COOKIE controls the Secure flag on the session cookie independently
// of NODE_ENV.  Set to 'true' only when serving over HTTPS.
// In a local Docker Compose setup (HTTP), this must be 'false' (the default)
// or the browser will silently drop the cookie and every API call returns 401.
const SECURE_COOKIE = process.env.SECURE_COOKIE === "true";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, "..", "dist");

// ── Client log file ─────────────────────────────────────────────────────────
// Browser-side `logger` calls relay through /api/logs/client. We append every
// relayed line to a per-process file so Claude / engineers can grep without
// scrolling the terminal. The file truncates on every Bun startup so a stale
// log from yesterday's session can't mislead. Path is configurable via
// CLIENT_LOG_PATH; default lives next to the dist dir under the project so
// it's discoverable.
const CLIENT_LOG_PATH = process.env.CLIENT_LOG_PATH
  ?? join(__dirname, "..", ".client.log");

let clientLogFd = null;
try {
  clientLogFd = openSync(CLIENT_LOG_PATH, "w"); // 'w' truncates on open
  console.log(`[bun]  Client log → ${CLIENT_LOG_PATH} (truncated)`);
} catch (e) {
  console.warn(`[bun]  could not open client log at ${CLIENT_LOG_PATH}:`, e.message);
}

function appendClientLog(line) {
  if (clientLogFd == null) return;
  try { writeSync(clientLogFd, line + "\n"); } catch { /* fd closed or disk full */ }
}

// Flush + close on shutdown so the OS releases the inode promptly.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (clientLogFd != null) { try { closeSync(clientLogFd); } catch {} clientLogFd = null; }
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// In-memory session store  { token -> { user, createdAt } }
// ---------------------------------------------------------------------------

/** @type {Map<string, { user: string; createdAt: number }>} */
const sessions = new Map();

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

function createSession(user) {
  const token = crypto.randomUUID() + "-" + crypto.randomUUID();
  sessions.set(token, { user, createdAt: Date.now() });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function destroySession(token) {
  sessions.delete(token);
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

const COOKIE_NAME = "gs_session";
const COOKIE_NAME_GUEST = "gs_guest";
const COOKIE_OPTS = [
  "HttpOnly",
  "SameSite=Strict",
  "Path=/",
  SECURE_COOKIE ? "Secure" : "",
]
  .filter(Boolean)
  .join("; ");

function readCookie(req, name) {
  const cookieHeader = req.headers.get("cookie") ?? "";
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function getSessionToken(req) {
  return readCookie(req, COOKIE_NAME);
}

function getGuestToken(req) {
  // Same-origin browser guests use the cookie. A cross-origin client (the
  // desktop app joining a remote wall) can't send a SameSite=Strict cookie,
  // so also accept the token as a bearer header — it's returned from
  // /auth/guest redemption for exactly this case. CORS already allows the
  // Authorization header (see corsHeaders).
  const cookie = readCookie(req, COOKIE_NAME_GUEST);
  if (cookie) return cookie;
  const auth = req.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return req.headers.get("x-guest-token") || null;
}

function setSessionCookie(token, maxAge = SESSION_TTL_MS / 1000) {
  return `${COOKIE_NAME}=${token}; Max-Age=${maxAge}; ${COOKIE_OPTS}`;
}

function setGuestCookie(token, maxAge) {
  return `${COOKIE_NAME_GUEST}=${token}; Max-Age=${maxAge}; ${COOKIE_OPTS}`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; Max-Age=0; ${COOKIE_OPTS}`;
}

function clearGuestCookie() {
  return `${COOKIE_NAME_GUEST}=; Max-Age=0; ${COOKIE_OPTS}`;
}

// ---------------------------------------------------------------------------
// Guest invites + sessions
//
// Invites are short-lived "Give Control" credentials issued by an operator.
// The QR code encodes a deep-link with the `token` (16-byte URL-safe);
// the operator can also dictate the 6-digit `otp` for manual entry.
// Single-use by default; redemption mints a guest cookie scoped by tier.
//
// All state is in-memory — a Bun restart wipes invites and forces guests
// to be re-issued. If we ever scale to multiple Bun instances behind a LB,
// this needs externalising (Redis or similar). Single-instance only today.
// ---------------------------------------------------------------------------

/** @type {Map<string, {
 *   id: string,
 *   token: string,
 *   otp: string,
 *   sessionKey: string,
 *   permissions: 'story' | 'story+chat' | 'full',
 *   label: string,
 *   maxUses: number,
 *   usedCount: number,
 *   createdAt: number,
 *   expiresAt: number,
 *   otpExpiresAt: number,
 * }>} */
const invites = new Map();

/** @type {Map<string, {
 *   inviteId: string,
 *   sessionKey: string,
 *   permissions: string,
 *   label: string,
 *   createdAt: number,
 * }>} */
const guestSessions = new Map();

/** @type {Map<string, { attempts: number, firstAt: number }>} */
const otpRateLimits = new Map();

const INVITE_TTL_MS = 60 * 60 * 1000;          // 1 hour
const OTP_TTL_MS    = 10 * 60 * 1000;          // 10 minutes
const GUEST_TTL_MS  = 60 * 60 * 1000;          // 1 hour
const OTP_MAX_ATTEMPTS = 5;
const OTP_WINDOW_MS = 15 * 60 * 1000;          // 15 min sliding window

const ALLOWED_PERMISSIONS = new Set(["story", "story+chat", "full"]);

// Per-tier API allow-list. Each entry is a regex matched against pathname.
// Guest cookies whose permission tier doesn't match get 403 at the edge.
// `full` is documented as a shadow-login: still NOT permitted to mint or
// revoke invites (operator-only).
const GUEST_ROUTE_ALLOW = {
  story: [
    /^\/api\/stories(\/|$)/,
    /^\/api\/perspectives(\/|$)/,
    /^\/api\/projects(\/|$)/,
    /^\/api\/extensions$/,                     // list only, no preference
    /^\/api\/sync\/sessions(\/|$)/,
  ],
  "story+chat": [
    /^\/api\/stories(\/|$)/,
    /^\/api\/perspectives(\/|$)/,
    /^\/api\/projects(\/|$)/,
    /^\/api\/extensions$/,
    /^\/api\/sync\/sessions(\/|$)/,
    /^\/api\/chat(\/|$)/,
  ],
  full: [
    /^\/api\/(?!invites)/,                     // everything except invite admin
  ],
};

function lazySweepInvite(inv) {
  if (!inv) return null;
  const now = Date.now();
  if (now > inv.expiresAt || inv.usedCount >= inv.maxUses) {
    invites.delete(inv.id);
    return null;
  }
  return inv;
}

function makeOtp() {
  // 6-digit numeric OTP. Re-roll if it collides with a live invite.
  for (let attempt = 0; attempt < 16; attempt++) {
    const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
    let collision = false;
    for (const inv of invites.values()) {
      if (lazySweepInvite(inv) && inv.otp === code) { collision = true; break; }
    }
    if (!collision) return code;
  }
  // Astronomically unlikely; surface rather than retry-forever.
  throw new Error("[invites] could not allocate a unique OTP");
}

function tokenUrlSafe(byteLen) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLen));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function recordOtpAttempt(ip) {
  const now = Date.now();
  const entry = otpRateLimits.get(ip);
  if (!entry || (now - entry.firstAt) > OTP_WINDOW_MS) {
    otpRateLimits.set(ip, { attempts: 1, firstAt: now });
    return { ok: true };
  }
  entry.attempts += 1;
  if (entry.attempts > OTP_MAX_ATTEMPTS) {
    return { ok: false, retryAfterMs: OTP_WINDOW_MS - (now - entry.firstAt) };
  }
  return { ok: true };
}

function clientIp(req) {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  return "unknown";
}

function isAllowedForGuest(pathname, permissions) {
  const allowList = GUEST_ROUTE_ALLOW[permissions];
  if (!allowList) return false;
  return allowList.some((rx) => rx.test(pathname));
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });

const err = (message, status = 400) => json({ error: message }, status);

// ---------------------------------------------------------------------------
// CORS / shared headers (dev only – Vite dev server is a different origin)
// ---------------------------------------------------------------------------

// True for a Tauri desktop webview origin (the only legitimate cross-origin
// caller in production — it joins a remote wall's session). Web clients are
// same-origin with this proxy and never need CORS.
function isDesktopOrigin(origin) {
  if (!origin) return false;
  if (origin.startsWith("tauri://")) return true;
  try { return new URL(origin).hostname === "tauri.localhost"; } catch { return false; }
}

function corsHeaders(req) {
  const origin = req.headers.get("origin");
  // Dev: the Vite dev server is a separate origin. Prod: only the desktop
  // app (a Tauri webview redeeming a control invite against this wall) is
  // cross-origin, so reflect just that origin and stay closed otherwise.
  if (IS_PROD && !isDesktopOrigin(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin ?? "http://localhost:5173",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

// ---------------------------------------------------------------------------
// Auth handlers
// ---------------------------------------------------------------------------

async function handleLogin(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body");
  }

  const { username, password } = body ?? {};

  if (
    typeof username !== "string" ||
    typeof password !== "string" ||
    username !== ADMIN_USER ||
    password !== ADMIN_PASS
  ) {
    return err("Invalid credentials", 401);
  }

  const token = createSession(username);
  return json({ ok: true, user: username }, 200, {
    "Set-Cookie": setSessionCookie(token),
    ...corsHeaders(req),
  });
}

function handleLogout(req) {
  const token = getSessionToken(req);
  if (token) destroySession(token);
  return json({ ok: true }, 200, {
    "Set-Cookie": clearSessionCookie(),
    ...corsHeaders(req),
  });
}

function handleSessionCheck(req) {
  const token = getSessionToken(req);
  const session = getSession(token);
  if (session) {
    return json(
      { authenticated: true, mode: "operator", user: session.user },
      200,
      corsHeaders(req),
    );
  }
  // Fall back to guest cookie — let the auth context know it's a guest
  // session so it can render the appropriate restricted UI.
  const guestToken = getGuestToken(req);
  const guest = guestSessions.get(guestToken);
  if (guest) {
    return json(
      { authenticated: true, mode: "guest", permissions: guest.permissions, label: guest.label },
      200,
      corsHeaders(req),
    );
  }
  return json({ authenticated: false }, 401, corsHeaders(req));
}

// ---------------------------------------------------------------------------
// Invite + guest auth handlers
// ---------------------------------------------------------------------------

async function handleCreateInvite(req) {
  // Only authenticated operators can mint invites.
  const session = getSession(getSessionToken(req));
  if (!session) return err("Unauthorized", 401);

  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON body"); }

  const permissions = body?.permissions ?? "story";
  const sessionKey = body?.sessionKey;
  const label = String(body?.label ?? "Guest").slice(0, 60);
  const maxUses = Math.max(1, Math.min(20, Number(body?.maxUses ?? 1)));

  if (!ALLOWED_PERMISSIONS.has(permissions)) return err("Invalid permissions tier");
  if (typeof sessionKey !== "string" || !sessionKey.length) return err("sessionKey required");

  const id = tokenUrlSafe(8);
  const token = tokenUrlSafe(16);
  const otp = makeOtp();
  const now = Date.now();

  const invite = {
    id,
    token,
    otp,
    sessionKey,
    permissions,
    label,
    maxUses,
    usedCount: 0,
    createdAt: now,
    expiresAt: now + INVITE_TTL_MS,
    otpExpiresAt: now + OTP_TTL_MS,
  };
  invites.set(id, invite);

  return json({
    id,
    token,
    otp,
    permissions,
    sessionKey,
    label,
    expiresAt: invite.expiresAt,
    otpExpiresAt: invite.otpExpiresAt,
  }, 200, corsHeaders(req));
}

function handleListInvites(req) {
  const session = getSession(getSessionToken(req));
  if (!session) return err("Unauthorized", 401);

  // Lazy sweep on access — keeps the response shape clean.
  const live = [];
  for (const inv of invites.values()) {
    const swept = lazySweepInvite(inv);
    if (!swept) continue;
    // Count active guest sessions tied to this invite.
    let guestCount = 0;
    for (const g of guestSessions.values()) {
      if (g.inviteId === swept.id) guestCount += 1;
    }
    live.push({
      id: swept.id,
      permissions: swept.permissions,
      label: swept.label,
      maxUses: swept.maxUses,
      usedCount: swept.usedCount,
      expiresAt: swept.expiresAt,
      guestCount,
    });
  }
  return json({ invites: live }, 200, corsHeaders(req));
}

function handleRevokeInvite(req, inviteId) {
  const session = getSession(getSessionToken(req));
  if (!session) return err("Unauthorized", 401);

  invites.delete(inviteId);
  // Revoke any guest sessions issued from this invite.
  for (const [token, g] of guestSessions) {
    if (g.inviteId === inviteId) guestSessions.delete(token);
  }
  // Best-effort: ask FastAPI to drop matching WS clients. Failure is
  // non-fatal — the cookie is gone, so any reconnect attempt will 401.
  fetch(`${BACKEND_URL}/api/sync/invites/${encodeURIComponent(inviteId)}/clients`, {
    method: "DELETE",
    headers: { "X-MyApp-ApiKey": API_KEY },
  }).catch(() => { /* swallow */ });
  return json({ ok: true }, 200, corsHeaders(req));
}

async function handleGuestRedeem(req) {
  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON body"); }

  let invite = null;

  if (typeof body?.token === "string" && body.token.length) {
    // Token path — find by token.
    for (const inv of invites.values()) {
      if (lazySweepInvite(inv) && inv.token === body.token) { invite = inv; break; }
    }
  } else if (typeof body?.otp === "string" && /^\d{6}$/.test(body.otp)) {
    // OTP path — rate-limit, then find by otp.
    const ip = clientIp(req);
    const rl = recordOtpAttempt(ip);
    if (!rl.ok) {
      return json({ error: "Too many attempts", retryAfterMs: rl.retryAfterMs }, 429, corsHeaders(req));
    }
    const now = Date.now();
    for (const inv of invites.values()) {
      if (!lazySweepInvite(inv)) continue;
      if (inv.otp === body.otp && now <= inv.otpExpiresAt) { invite = inv; break; }
    }
  } else {
    return err("token or otp required");
  }

  if (!invite) return err("Invalid or expired invite", 404);

  // Burn one use. OTP path additionally invalidates the OTP after first
  // success (token can stay live for the remaining maxUses if any).
  invite.usedCount += 1;
  if (body?.otp) invite.otpExpiresAt = 0;
  if (invite.usedCount >= invite.maxUses) invites.delete(invite.id);

  const guestToken = tokenUrlSafe(16);
  guestSessions.set(guestToken, {
    inviteId: invite.id,
    sessionKey: invite.sessionKey,
    permissions: invite.permissions,
    label: invite.label,
    createdAt: Date.now(),
  });

  // Mint the first WS ticket here so a cross-origin client (desktop) can
  // connect immediately without a follow-up cookie-authed /auth/guest/me.
  const wsTicket = await mintWsTicket(invite.sessionKey, invite.id);

  return json({
    ok: true,
    permissions: invite.permissions,
    sessionKey: invite.sessionKey,
    label: invite.label,
    // For cross-origin clients (desktop): the guest token to send as a
    // bearer on later /auth/guest/* calls, plus the initial WS ticket.
    guestToken,
    wsTicket,
  }, 200, {
    "Set-Cookie": setGuestCookie(guestToken, GUEST_TTL_MS / 1000),
    ...corsHeaders(req),
  });
}

async function handleGuestMe(req) {
  const guestToken = getGuestToken(req);
  const guest = guestSessions.get(guestToken);
  if (!guest) return err("No guest session", 401);
  // Mint a fresh 30s WS ticket and register it with FastAPI.
  const ticket = await mintWsTicket(guest.sessionKey, guest.inviteId);
  return json({
    permissions: guest.permissions,
    sessionKey: guest.sessionKey,
    label: guest.label,
    wsTicket: ticket,
  }, 200, corsHeaders(req));
}

async function handleGuestWsTicket(req) {
  const guestToken = getGuestToken(req);
  const guest = guestSessions.get(guestToken);
  if (!guest) return err("No guest session", 401);
  const ticket = await mintWsTicket(guest.sessionKey, guest.inviteId);
  return json({ ticket, sessionKey: guest.sessionKey }, 200, corsHeaders(req));
}

function handleGuestLogout(req) {
  const guestToken = getGuestToken(req);
  if (guestToken) guestSessions.delete(guestToken);
  return json({ ok: true }, 200, {
    "Set-Cookie": clearGuestCookie(),
    ...corsHeaders(req),
  });
}

async function mintWsTicket(sessionKey, inviteId) {
  const ticket = tokenUrlSafe(16);
  // Register with FastAPI so it can validate at WS handshake. The
  // backend stores ticket → sessionKey for ~60s and removes after first
  // successful WS connect or expiry.
  try {
    await fetch(`${BACKEND_URL}/api/sync/ws-tickets`, {
      method: "POST",
      headers: {
        "X-MyApp-ApiKey": API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ticket, sessionKey, inviteId, ttlMs: 60_000 }),
    });
  } catch (e) {
    console.error("[guest] ws-ticket registration failed:", e);
  }
  return ticket;
}

// ---------------------------------------------------------------------------
// WebSocket upgrade-proxy for /ws/sync/*
//
// In production, Bun is the only public surface — FastAPI is reachable
// only via in-cluster DNS. The state-bus WebSocket therefore has to be
// relayed through this process. We accept the upgrade here, open a
// matching client connection to BACKEND_URL, and pipe frames in both
// directions until either side closes.
//
// Auth is enforced at the upgrade: guest tabs must carry a `?ticket=...`
// (FastAPI consumes/validates it on its end); operator tabs must present
// a valid session cookie.
// ---------------------------------------------------------------------------

const BACKEND_WS_URL = BACKEND_URL.replace(/^http/, "ws");

function handleSyncWsUpgrade(req, server, pathname) {
  const url = new URL(req.url);
  const ticket = url.searchParams.get("ticket");

  if (!ticket) {
    const operator = getSession(getSessionToken(req));
    if (!operator) return err("Unauthorized", 401);
  }

  const sessionKey = pathname.slice("/ws/sync/".length);
  if (!sessionKey) return err("Missing session key", 400);

  const upstreamUrl =
    `${BACKEND_WS_URL}/ws/sync/${encodeURIComponent(decodeURIComponent(sessionKey))}` +
    (ticket ? `?ticket=${encodeURIComponent(ticket)}` : "");

  const ok = server.upgrade(req, {
    data: { upstreamUrl, sessionKey },
  });
  if (!ok) return err("WebSocket upgrade failed", 426);
  return undefined;
}

// ---------------------------------------------------------------------------
// Backend proxy helper
// ---------------------------------------------------------------------------

/**
 * Forward a request to the Python backend, injecting the API key header.
 * @param {string} backendPath  – path + query string to append to BACKEND_URL
 * @param {Request} req         – original incoming request (for method/body/headers)
 */
async function proxyToBackend(backendPath, req) {
  const url = `${BACKEND_URL}${backendPath}`;

  const headers = new Headers();
  headers.set("X-MyApp-ApiKey", API_KEY);
  // Forward content-type and content-length for POST/PUT bodies
  const ct = req.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  const cl = req.headers.get("content-length");
  if (cl) headers.set("content-length", cl);

  // Body forwarding has two paths:
  //
  // - **Default (streaming):** pass `req.body` as a ReadableStream with
  //   `duplex: "half"`. Zero-copy, used for every non-multipart body.
  //
  // - **Multipart spool:** Bun's `fetch` with `duplex: "half"` silently
  //   stalls on multipart request bodies — first confirmed against 3 GB
  //   Sienna HDF5 uploads, then again on a modest CSV geometry upload
  //   (browser shows the request sent, Bun opens the upstream socket, and
  //   FastAPI sits awaiting a body that never arrives: every socket queue
  //   in the chain at zero, server at 0% CPU, no error anywhere). The
  //   workaround is to stream the body to a temp file and POST it as
  //   `Bun.file(path)`, which goes through Bun's optimized file-upload
  //   path and works at any size.
  //
  // This used to be gated on `content-length > 512 MB`. That gate had a
  // hole: `content-length` is absent on a chunked upload, so declaredLength
  // fell back to 0, failed the size test, and took the very path that
  // stalls — the failure was never about size. Multipart is always a file
  // transfer, so the copy is worth the determinism; the zero-copy path
  // stays for JSON and everything else.
  let body = req.method === "GET" || req.method === "HEAD" ? undefined : req.body;
  let spoolPath = null;
  if (body && ct?.startsWith("multipart/form-data")) {
    spoolPath = `/tmp/bun_proxy_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const sink = Bun.file(spoolPath).writer();
    try {
      for await (const chunk of req.body) {
        sink.write(chunk);
      }
      await sink.end();
    } catch (e) {
      try { await sink.end(); } catch { /* swallow */ }
      try { await unlink(spoolPath); } catch { /* swallow */ }
      throw e;
    }
    body = Bun.file(spoolPath);
  }

  let upstream;
  try {
    upstream = await fetch(url, {
      method: req.method,
      headers,
      body,
      duplex: body && !spoolPath ? "half" : undefined,
    });
  } finally {
    // The spool file is only needed for the duration of the upstream
    // POST. Bun.file holds an fd and frees it once the fetch finishes.
    if (spoolPath) {
      try { await unlink(spoolPath); } catch { /* swallow */ }
    }
  }

  // Stream the response body back, preserving status + relevant headers
  const responseHeaders = new Headers();
  const upstreamCT = upstream.headers.get("content-type");
  if (upstreamCT) responseHeaders.set("content-type", upstreamCT);

  // Forward SSE / streaming headers
  const cacheControl = upstream.headers.get("cache-control");
  if (cacheControl) responseHeaders.set("cache-control", cacheControl);
  const accelBuffering = upstream.headers.get("x-accel-buffering");
  if (accelBuffering) responseHeaders.set("x-accel-buffering", accelBuffering);

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

// ---------------------------------------------------------------------------
// API route dispatcher
// ---------------------------------------------------------------------------

/**
 * Maps frontend API paths to backend paths.
 *
 * Frontend route                       → Backend route
 * GET /api/projects                    → GET /api/projects
 * GET /api/projects/:project           → GET /api/projects/:project
 * GET /api/geo/:p/:s/:file             → GET /api/geo/:p/:s/:file
 * GET /api/timeseries/:p/:s            → GET /api/timestep/:p/:s        (date range)
 * GET /api/timeseries/:p/:s/:index     → GET /api/timestep/:p/:s/:index (timestep)
 */
async function handleApiRequest(pathname, req) {
  // Operator session takes precedence — they have full access. If absent,
  // fall back to a guest session and enforce the per-tier allow-list.
  const operator = getSession(getSessionToken(req));
  if (!operator) {
    const guest = guestSessions.get(getGuestToken(req));
    if (!guest) {
      return json({ error: "Unauthorized" }, 401, corsHeaders(req));
    }
    if (!isAllowedForGuest(pathname, guest.permissions)) {
      return json(
        { error: "Forbidden for guest tier", permissions: guest.permissions },
        403, corsHeaders(req),
      );
    }
  }

  // ── Client-side log relay ──────────────────────────────────────────────────
  // Handled here in Bun so [web] logs appear in the same terminal as [server]
  // logs without an extra round-trip to the Python backend.
  if (pathname === '/api/logs/client' && req.method === 'POST') {
    let entry = {};
    try { entry = await req.json(); } catch { /* ignore malformed body */ }
    const level = String(entry.level ?? 'info').toUpperCase().padEnd(5);
    const ts = entry.ts ? `${entry.ts} ` : '';
    const line = `[web]  ${level} ${ts}${entry.message ?? ''}`;
    console.log(line);
    appendClientLog(line);
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  // ── /api/projects ──────────────────────────────────────────────────────────
  const projectsMatch = pathname.match(/^\/api\/projects(?:\/([^/]+))?$/);
  if (projectsMatch) {
    const project = projectsMatch[1];
    const backendPath = project
      ? `/api/projects/${encodeURIComponent(project)}`
      : "/api/projects";
    try {
      const res = await proxyToBackend(backendPath, req);
      // The Python backend wraps lists under { body: [...] } for projects
      if (res.headers.get("content-type")?.includes("application/json")) {
        const data = await res.json();
        const unwrapped = data?.body !== undefined ? data.body : data;
        return json(unwrapped, res.status, corsHeaders(req));
      }
      return res;
    } catch (e) {
      console.error("[proxy] projects error:", e);
      return err("Backend unavailable", 502);
    }
  }

  // ── /api/geo/:project/:scenario/:filename ──────────────────────────────────
  const geoMatch = pathname.match(/^\/api\/geo\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (geoMatch) {
    const [, project, scenario, filename] = geoMatch;
    try {
      return await proxyToBackend(
        `/api/geo/${encodeURIComponent(project)}/${encodeURIComponent(scenario)}/${encodeURIComponent(filename)}`,
        req,
      );
    } catch (e) {
      console.error("[proxy] geo error:", e);
      return err("Backend unavailable", 502);
    }
  }

  // ── /api/timeseries/:project/:scenario/:index  (timestep) ─────────────────
  const timestepMatch = pathname.match(
    /^\/api\/timeseries\/([^/]+)\/([^/]+)\/([^/]+)$/,
  );
  if (timestepMatch) {
    const [, project, scenario, index] = timestepMatch;
    try {
      return await proxyToBackend(
        `/api/timestep/${encodeURIComponent(project)}/${encodeURIComponent(scenario)}/${encodeURIComponent(index)}`,
        req,
      );
    } catch (e) {
      console.error("[proxy] timestep error:", e);
      return err("Backend unavailable", 502);
    }
  }

  // ── /api/timeseries/:project/:scenario  (date range) ──────────────────────
  const timeseriesMatch = pathname.match(
    /^\/api\/timeseries\/([^/]+)\/([^/]+)$/,
  );
  if (timeseriesMatch) {
    const [, project, scenario] = timeseriesMatch;
    try {
      return await proxyToBackend(
        `/api/timestep/${encodeURIComponent(project)}/${encodeURIComponent(scenario)}`,
        req,
      );
    } catch (e) {
      console.error("[proxy] timeseries error:", e);
      return err("Backend unavailable", 502);
    }
  }

  // ── catch-all: proxy any other /api/* route straight through ──────────────
  // Unwrap the Flask envelope { statusCode, headers, body } that make_response
  // produces, the same way the explicit /api/projects handler does above.
  const url = new URL(req.url);
  try {
    const res = await proxyToBackend(url.pathname + url.search, req);
    if (res.headers.get("content-type")?.includes("application/json")) {
      const data = await res.json();
      const unwrapped = data?.body !== undefined ? data.body : data;
      return json(unwrapped, res.status, corsHeaders(req));
    }
    return new Response(res.body, {
      status: res.status,
      headers: { ...corsHeaders(req), "content-type": res.headers.get("content-type") ?? "application/octet-stream" },
    });
  } catch (e) {
    console.error("[proxy] catch-all error:", e);
    return err("Backend unavailable", 502);
  }
}

// ---------------------------------------------------------------------------
// Static file serving (production)
// ---------------------------------------------------------------------------

async function serveStatic(pathname) {
  // Normalise: strip leading slash, default to index.html
  let relative = pathname.replace(/^\//, "") || "index.html";
  let filePath = join(DIST_DIR, relative);

  if (!existsSync(filePath)) {
    // SPA fallback – serve index.html for unknown routes
    filePath = join(DIST_DIR, "index.html");
  }

  const file = Bun.file(filePath);
  return new Response(file);
}

// ---------------------------------------------------------------------------
// Main request handler
// ---------------------------------------------------------------------------

async function handleRequest(req, server) {
  const url = new URL(req.url);
  const { pathname } = url;

  // Pre-flight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  // ── Health check (used by k8s readiness probe) ────────────────────────────
  if (pathname === "/health" && req.method === "GET")
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  // ── Auth routes ────────────────────────────────────────────────────────────
  if (pathname === "/auth/login" && req.method === "POST")
    return handleLogin(req);
  if (pathname === "/auth/logout" && req.method === "POST")
    return handleLogout(req);
  if (pathname === "/auth/session" && req.method === "GET")
    return handleSessionCheck(req);

  // ── Guest-control routes ──────────────────────────────────────────────────
  if (pathname === "/auth/guest" && req.method === "POST")
    return handleGuestRedeem(req);
  if (pathname === "/auth/guest/me" && req.method === "GET")
    return handleGuestMe(req);
  if (pathname === "/auth/guest/ws-ticket" && req.method === "POST")
    return handleGuestWsTicket(req);
  if (pathname === "/auth/guest/logout" && req.method === "POST")
    return handleGuestLogout(req);

  // ── Invite admin (operator-only; checked inside the handlers) ─────────────
  if (pathname === "/api/invites" && req.method === "POST")
    return handleCreateInvite(req);
  if (pathname === "/api/invites" && req.method === "GET")
    return handleListInvites(req);
  const revokeMatch = pathname.match(/^\/api\/invites\/([^/]+)$/);
  if (revokeMatch && req.method === "DELETE")
    return handleRevokeInvite(req, revokeMatch[1]);

  // ── WebSocket upgrade for state-bus sync ───────────────────────────────────
  if (pathname.startsWith("/ws/sync/")) {
    const result = handleSyncWsUpgrade(req, server, pathname);
    if (result === undefined) return undefined; // upgraded
    return result;
  }

  // ── MCP bus SSE stream ─────────────────────────────────────────────────────
  // Read-only Server-Sent Events stream of MCP bus injects, so a plain browser
  // (dev or deployed web wall display) can receive MCP-driven commands the way
  // the Tauri desktop app does. Only the GET stream is proxied — never the
  // POST /internal/bus/inject endpoint, which stays server-to-server. The
  // backend authenticates via the X-MyApp-ApiKey header that proxyToBackend
  // injects, so the browser never holds the key.
  if (pathname === "/internal/bus/stream" && req.method === "GET") {
    return proxyToBackend(pathname + url.search, req);
  }

  // ── API proxy routes ───────────────────────────────────────────────────────
  if (pathname.startsWith("/api/")) {
    return handleApiRequest(pathname, req);
  }

  // ── Static assets (production) ─────────────────────────────────────────────
  if (IS_PROD) {
    return serveStatic(pathname);
  }

  // In development the Vite dev server handles static assets; any unmatched
  // request reaching this server is unexpected.
  return err("Not found", 404);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  // 255s is Bun's max — gives the upload body intake time on slow links.
  // The upload itself is now a background job on the FastAPI side
  // (POST returns a job_id immediately, client polls), so this only
  // needs to cover the multipart upload + initial 200 OK.
  idleTimeout: 255,
  // 4 GB — power-system simulation HDF5s routinely run several
  // hundred MB to ~1 GB each, and a Sienna scenario uploads multiple
  // simultaneously. With the streaming proxy below the body never
  // sits fully in memory, so this is just a hard ceiling against
  // runaway uploads, not a steady-state allocation.
  maxRequestBodySize: 4 * 1024 * 1024 * 1024,
  fetch: handleRequest,
  // State-bus WebSocket relay. The downstream client speaks to us; we
  // open a matching upstream WebSocket to FastAPI and pipe frames both
  // ways. `data` is populated by handleSyncWsUpgrade.
  websocket: {
    open(ws) {
      const { upstreamUrl } = ws.data;
      const upstream = new WebSocket(upstreamUrl);
      ws.data.upstream = upstream;
      ws.data.upstreamReady = false;
      ws.data.queue = [];
      ws.data.closed = false;

      upstream.addEventListener("open", () => {
        ws.data.upstreamReady = true;
        for (const frame of ws.data.queue) upstream.send(frame);
        ws.data.queue.length = 0;
      });
      upstream.addEventListener("message", (ev) => {
        if (ws.data.closed) return;
        ws.send(ev.data);
      });
      upstream.addEventListener("close", (ev) => {
        if (ws.data.closed) return;
        try {
          // WebSocket close codes 1000-4999 are valid for forwarding;
          // anything else (e.g. 1006 abnormal) we map to 1011.
          const code = ev.code >= 1000 && ev.code < 5000 ? ev.code : 1011;
          ws.close(code, ev.reason || "");
        } catch {}
      });
      upstream.addEventListener("error", () => {
        if (ws.data.closed) return;
        try { ws.close(1011, "Upstream error"); } catch {}
      });
    },
    message(ws, msg) {
      const { upstream, upstreamReady, queue } = ws.data;
      if (!upstream) return;
      if (upstreamReady) {
        upstream.send(msg);
      } else {
        // Cap the queue so a stalled upstream can't OOM us.
        if (queue.length < 200) queue.push(msg);
      }
    },
    close(ws) {
      ws.data.closed = true;
      try { ws.data.upstream?.close(); } catch {}
    },
    // Generous backpressure budget — sync messages are small and frequent,
    // and we don't want benign bursts to terminate the connection.
    maxPayloadLength: 16 * 1024 * 1024,
    idleTimeout: 120, // seconds; FastAPI relay has no app-level ping
  },
  error(error) {
    console.error("[server] Unhandled error:", error);
    return new Response("Internal Server Error", { status: 500 });
  },
});

console.log(
  `✅ Meridian API server running on http://localhost:${server.port}`,
);
console.log(`   Mode      : ${IS_PROD ? "production" : "development"}`);
console.log(`   Backend   : ${BACKEND_URL}`);
if (IS_PROD) {
  console.log(`   Serving   : ${DIST_DIR}`);
}

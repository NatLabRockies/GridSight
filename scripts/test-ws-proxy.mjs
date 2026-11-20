#!/usr/bin/env bun
// End-to-end smoke test for the Bun → FastAPI WebSocket relay.
//
// Run dev.sh in another terminal first, then:
//   bun scripts/test-ws-proxy.mjs
//
// What it verifies:
//   1. Bun accepts the /ws/sync/* upgrade with an operator cookie
//   2. The upstream FastAPI /ws/sync/{key} relay is reachable through Bun
//   3. Frames from one client reach a second client in the same session
//   4. Presence updates arrive on join

// Defaults match dev.sh, which uses hardcoded creds and ignores repo .env.
// Override with env vars if you've started Bun with different creds.
const BASE = process.env.BUN_URL ?? "http://localhost:3001";
const WS_BASE = BASE.replace(/^http/, "ws");
const USER = process.env.ADMIN_USER ?? "admin";
const PASS = process.env.ADMIN_PASS ?? "changeme";

function fail(msg) { console.error("✖", msg); process.exit(1); }
function ok(msg)   { console.log("✓", msg); }

async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!res.ok) fail(`login ${res.status}: ${await res.text()}`);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) fail("no Set-Cookie from /auth/login");
  // Take the first cookie name=value pair
  const cookie = setCookie.split(";")[0];
  ok(`logged in (${cookie.split("=")[0]})`);
  return cookie;
}

function openWs(cookie, sessionKey, label) {
  const url = `${WS_BASE}/ws/sync/${encodeURIComponent(sessionKey)}`;
  // Bun supports a non-standard `headers` option on the WS client.
  const ws = new WebSocket(url, { headers: { Cookie: cookie } });
  ws._label = label;
  ws._frames = [];
  ws.addEventListener("message", (ev) => {
    try { ws._frames.push(JSON.parse(ev.data)); }
    catch { ws._frames.push(ev.data); }
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => { ok(`[${label}] connected`); resolve(ws); });
    ws.addEventListener("error", () => reject(new Error(`[${label}] error`)));
    ws.addEventListener("close", (ev) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`[${label}] closed before open: ${ev.code} ${ev.reason}`));
      }
    });
    setTimeout(() => reject(new Error(`[${label}] open timeout`)), 5000);
  });
}

async function waitFor(ws, predicate, timeoutMs = 3000, what = "frame") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = ws._frames.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 25));
  }
  fail(`[${ws._label}] timed out waiting for ${what}; saw ${JSON.stringify(ws._frames)}`);
}

const sessionKey = `test-${crypto.randomUUID().slice(0, 8)}`;
ok(`session key: ${sessionKey}`);

const cookie = await login();

const a = await openWs(cookie, sessionKey, "A");
await waitFor(a, (m) => m.channel === "presence", 3000, "presence on join (1 peer)");
ok("[A] received presence");

const b = await openWs(cookie, sessionKey, "B");
await waitFor(b, (m) => m.channel === "presence" && m.payload?.peers?.length === 2,
  3000, "presence with 2 peers");
await waitFor(a, (m) => m.channel === "presence" && m.payload?.peers?.length === 2,
  3000, "presence rebroadcast after B joined");
ok("both clients see 2 peers");

const marker = `relay-${Date.now()}`;
a.send(JSON.stringify({
  channel: "test", action: "ping",
  payload: { marker }, sourceId: "A", timestamp: Date.now(),
}));
await waitFor(b, (m) => m.channel === "test" && m.payload?.marker === marker,
  2000, "relay frame from A");
ok("relay A → B verified");

if (a._frames.some((m) => m.channel === "test" && m.payload?.marker === marker)) {
  fail("A received its own frame back (relay should exclude sender)");
}
ok("sender exclusion verified");

a.close();
b.close();
ok("all checks passed");
process.exit(0);

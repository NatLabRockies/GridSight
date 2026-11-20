import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider, useAuth } from "./auth/AuthContext.jsx";
import { GridSightThemeProvider } from "./lib/ThemeContext.jsx";
import { DisplayScaleProvider } from "./lib/DisplayScaleContext.jsx";
import { DialogProvider } from "./lib/dialogs.jsx";
import { CategoryColorProvider } from "./lib/categoryColors.jsx";
import Login from "./auth/Login.jsx";
import { App } from "./components/App.jsx";
import { initDesktopBridge, isTauri } from "./lib/desktopBridge.js";
import { installChartDebug } from "./lib/chartDebug.js";
import gridsightIconSvg from "./gridsight_icon.svg?raw";
import "./styles/globals.css";

// Enrich Plotly's context-free "Too many auto-margin redraws" warning with a
// per-plot dump (component, container vs figure size, zoom) — see chartDebug.js.
installChartDebug();

// ChartTrayApp is a lightweight root for the dedicated chart-tray tab.
// Lazy-loaded so the primary bundle doesn't carry it for users who never
// pop the tray out to a second window.
const ChartTrayApp = lazy(() => import("./components/ChartTrayApp.jsx"));
const GuestEntry = lazy(() => import("./components/guest/GuestEntry.jsx"));

// ---------------------------------------------------------------------------
// View dispatch
// ---------------------------------------------------------------------------

// Decide which root to render based on the URL.
//   ?view=chartTray | ?view=control  → ChartTrayApp variant
//   /control[/:token]                → GuestEntry (auth bypass for the
//                                      guest-redemption flow)
//   anything else                    → full <App />
function pickRootView() {
  if (window.location.pathname.startsWith('/control')) return 'guest';
  const params = new URLSearchParams(window.location.search);
  return params.get("view") || "full";
}

const FullScreenMessage = ({ children }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      minHeight: "100vh",
      background: "#0d1117",
      color: "#fff",
      fontFamily: "sans-serif",
      fontSize: "1.1rem",
      letterSpacing: "0.05em",
    }}
  >
    {children}
  </div>
);

const LazyFallback = ({ label = "Loading…" }) => (
  <div style={{ color: "#fff", padding: 16, fontFamily: "sans-serif" }}>
    {label}
  </div>
);

// Maps a view key to the root component to render once the user is
// authenticated. Used only after the auth wall lets the user through.
const ROOT_VIEWS = {
  full: () => <App />,
  chartTray: () => (
    <Suspense fallback={<LazyFallback label="Loading chart tray…" />}>
      <ChartTrayApp mode="chartTray" />
    </Suspense>
  ),
  control: () => (
    <Suspense fallback={<LazyFallback label="Loading command center…" />}>
      <ChartTrayApp mode="control" />
    </Suspense>
  ),
};

// ---------------------------------------------------------------------------
// AppShell – decides whether to show Login or the main App
// ---------------------------------------------------------------------------

function AppShell() {
  const { authenticated, loading, login } = useAuth();
  const view = pickRootView();

  // Guest-redemption page bypasses the operator login wall entirely.
  // The component does its own POST /auth/guest and then redirects.
  if (view === 'guest') {
    return (
      <Suspense fallback={<LazyFallback />}>
        <GuestEntry />
      </Suspense>
    );
  }

  if (loading) return <FullScreenMessage>Loading…</FullScreenMessage>;
  if (!authenticated) return <Login onLogin={login} />;

  const render = ROOT_VIEWS[view] || ROOT_VIEWS.full;
  return render();
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

function AppProviders({ children }) {
  return (
    <DisplayScaleProvider>
      <GridSightThemeProvider>
        <CategoryColorProvider>
          <AuthProvider>
            {/* DialogProvider hosts the MUI replacement for window.prompt/
                confirm/alert. Must sit inside the theme provider so its
                dialogs pick up the active palette. */}
            <DialogProvider>{children}</DialogProvider>
          </AuthProvider>
        </CategoryColorProvider>
      </GridSightThemeProvider>
    </DisplayScaleProvider>
  );
}

const container = document.getElementById("root");

if (!container) {
  throw new Error(
    "[main.jsx] Could not find #root element. " +
      'Make sure index.html contains <div id="root"></div>.',
  );
}

// Splash screen shown during the ~3-8s sidecar cold boot. The GridSight
// icon SVG groups its three conceptual layers (generation / transmission
// / demand) as ``<g class="layer-…">``; CSS keyframes fade them in
// staggered then settle to the full composition, looping until the
// backend reports ``ready``. We inject the styles once on first call.
let _splashStylesInstalled = false;
function ensureSplashStyles() {
  if (_splashStylesInstalled) return;
  _splashStylesInstalled = true;
  const style = document.createElement("style");
  style.textContent = `
    .gridsight-splash {
      position: fixed; inset: 0;
      display: flex; align-items: center; justify-content: center;
      flex-direction: column;
      background: #0d1117; color: #fff;
      font-family: system-ui, -apple-system, sans-serif;
    }
    .gridsight-splash svg {
      /* Splash uses the SVG at full canvas (no icon-grid padding),
         so we can render it larger than a dock icon would be. */
      width: 320px; height: 320px;
      filter: drop-shadow(0 0 32px rgba(40, 90, 160, 0.3));
    }
    /* One 3.6s cycle, all three layers share the same duration so they
       reset in unison:
         0.00-0.30s  layer-gen fades in
         0.30-0.60s  layer-tx fades in
         0.60-0.90s  layer-demand fades in
         0.90-3.20s  hold full composition (the "pause at the end")
         3.20-3.50s  fade everything out
         3.50-3.60s  blank, then the loop restarts
       Separate @keyframes per layer (rather than animation-delay) keeps
       the resets perfectly aligned. */
    .gridsight-splash .layer { opacity: 0; }
    .gridsight-splash .layer-gen    { animation: gridsight-gen    3.6s ease-in-out infinite; }
    .gridsight-splash .layer-tx     { animation: gridsight-tx     3.6s ease-in-out infinite; }
    .gridsight-splash .layer-demand { animation: gridsight-demand 3.6s ease-in-out infinite; }
    @keyframes gridsight-gen {
      0%   { opacity: 0; }
      8%   { opacity: 1; }
      89%  { opacity: 1; }
      97%  { opacity: 0; }
      100% { opacity: 0; }
    }
    @keyframes gridsight-tx {
      0%   { opacity: 0; }
      8%   { opacity: 0; }
      17%  { opacity: 1; }
      89%  { opacity: 1; }
      97%  { opacity: 0; }
      100% { opacity: 0; }
    }
    @keyframes gridsight-demand {
      0%   { opacity: 0; }
      17%  { opacity: 0; }
      25%  { opacity: 1; }
      89%  { opacity: 1; }
      97%  { opacity: 0; }
      100% { opacity: 0; }
    }
    .gridsight-splash-title {
      font-size: 1.4rem; letter-spacing: 0.04em; margin-top: 16px;
    }
    .gridsight-splash-msg {
      font-size: 0.85rem; color: #8b949e; margin-top: 4px;
      min-height: 1.2em;
    }
  `;
  document.head.appendChild(style);
}

let _splashMounted = false;
function renderSplash(message) {
  ensureSplashStyles();
  if (!_splashMounted) {
    container.innerHTML = `
      <div class="gridsight-splash">
        ${gridsightIconSvg}
        <div class="gridsight-splash-title">GridSight</div>
        <div class="gridsight-splash-msg"></div>
      </div>`;
    _splashMounted = true;
  }
  const msgEl = container.querySelector(".gridsight-splash-msg");
  if (msgEl) msgEl.textContent = message;
}

function mountReact() {
  createRoot(container).render(
    <React.StrictMode>
      <AppProviders>
        <AppShell />
      </AppProviders>
    </React.StrictMode>,
  );
}

if (isTauri()) {
  renderSplash("Starting backend…");
  initDesktopBridge({
    onProgress: (status) => {
      if (status.phase === "provisioning") renderSplash(status.message || "Provisioning…");
      else if (status.phase === "launching") renderSplash("Launching backend…");
    },
  })
    .then(mountReact)
    .catch((err) => {
      renderSplash(`Failed to start backend: ${err?.message || err}`);
      console.error("[desktopBridge] init failed:", err);
    });
} else {
  // Plain browser: install the MCP SSE bridge (fire-and-forget) so this tab
  // receives MCP-driven bus commands, then mount immediately.
  initDesktopBridge().catch((e) => console.warn("[desktopBridge] browser init failed:", e));
  mountReact();
}

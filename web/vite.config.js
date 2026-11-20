import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Desktop mode routing: the Tauri Rust side registers a `meridian-api://`
// custom URI scheme protocol that proxies to the Python sidecar. The
// desktopBridge.js fetch override rewrites /api/* to that scheme, so Vite
// never sees those requests in Tauri mode. The /api proxy entry below is
// the web-mode (Bun) fallback for when the app runs in a plain browser.

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  server: {
    port: 5173,
    // Allow importing sibling-repo files (e.g. desktop/icons/meridian_icon.svg
    // for the boot splash). Without this, Vite's strict fs guard blocks
    // anything outside ``web/`` during dev.
    fs: {
      allow: [".."],
    },
    proxy: {
      // Bun-mode fallback. In desktop mode the plugin above handles /api
      // before this entry sees the request.
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        // Large scenario uploads (multi-GB) take longer than the default
        // 2-minute proxy timeout to stream through. `0` disables the
        // socket idle + total-request timers entirely — node-http-proxy
        // semantics. The browser still owns the upper bound via fetch's
        // own behavior.
        timeout: 0,
        proxyTimeout: 0,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, req) => {
            if (req.url?.includes("/api/chat") && req.method === "POST") {
              proxyReq.setHeader("Accept", "text/event-stream");
            }
          });
        },
      },
      // /auth is Bun-only; in desktop mode the bridge mocks these
      // client-side and they never hit the proxy.
      "/auth": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      // /internal/bus/stream — the MCP bus SSE stream, so a plain browser can
      // receive MCP commands. Routed through the bun proxy (which injects the
      // API key header). Streaming, so disable proxy timeouts.
      "/internal": {
        target: "http://localhost:3001",
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
      },
      "/ws": {
        target: "http://localhost:5001",
        changeOrigin: true,
        ws: true,
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },

  // Module workers (the per-layer-type precompute workers in
  // src/lib/workers/) dynamically import apache-arrow and share modules
  // like colormaps.js with the main bundle. Rollup's default IIFE worker
  // output can't code-split, so emit ESM workers instead.
  worker: {
    format: "es",
  },

  build: {
    outDir: "dist",
    // Source maps are disabled for production builds to prevent OOM in
    // memory-constrained Docker/Colima environments. deck.gl + maplibre
    // source maps alone exceed 8 GB of in-process memory during bundling.
    // Re-enable locally with: VITE_SOURCEMAP=true bun run build
    sourcemap: process.env.VITE_SOURCEMAP === "true",
    rollupOptions: {
      output: {
        // Function form, NOT array form. The array form only matches the
        // package's main entry — submodule imports like
        // `react/jsx-runtime` end up wherever they were first encountered
        // (often the MUI chunk), so the bundle ships two React copies and
        // chartgpu-react explodes with
        // "undefined is not an object (evaluating 'ys.__SECRET_INTERNALS_…')".
        // Path-based matching catches every submodule under the package.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules\/(react|react-dom|scheduler)(\/|$)/.test(id)) return "react";
          if (/node_modules\/(@mui|@emotion)(\/|$)/.test(id)) return "mui";
          if (/node_modules\/(deck\.gl|@deck\.gl)(\/|$)/.test(id)) return "deck";
          if (/node_modules\/(maplibre-gl|react-map-gl)(\/|$)/.test(id)) return "maplibre";
          if (/node_modules\/(chartgpu|chartgpu-react|@chartgpu)(\/|$)/.test(id)) return "charts";
          if (/node_modules\/apache-arrow(\/|$)/.test(id)) return "arrow";
          return undefined;
        },
      },
    },
  },

  // Allow importing CSS modules and global styles
  css: {
    postcss: "./postcss.config.js",
  },

  // Resolve aliases for cleaner imports
  resolve: {
    alias: {
      "@": "/src",
      "@components": "/src/components",
      "@lib": "/src/lib",
      "@auth": "/src/auth",
      "@styles": "/src/styles",
    },
  },

  // Optimize dependencies that ship CommonJS
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "deck.gl",
      "@deck.gl/carto",
      "@deck.gl/extensions",
      "maplibre-gl",
      "react-map-gl",
      "hammerjs",
      "apache-arrow",
    ],
  },
});

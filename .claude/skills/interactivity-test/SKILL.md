---
name: interactivity-test
description: Run GridSight's live interactivity regression suite — bring up the dev stack and drive the map, chart-frame, and MCP/stateBus handlers in a real browser via the preview tools, verifying each interaction GROUP independently so a regression in one area doesn't require re-running everything. Use when verifying frontend interactivity, stateBus channel handlers, or MCP-driven control after a change; when confirming a bug fix in those areas; or to add a newly-built interaction to the running checklist.
---

# GridSight interactivity test

A grouped, repeatable checklist for verifying GridSight's **interactive** behavior:
map camera control, chart frames, and the `stateBus` channel handlers that the
MCP server / remote sessions drive. Each **group** is independent and has its own
preconditions — run only the group(s) that a change could affect, not the whole
suite.

These tests drive the frontend by dispatching the exact `gridsight:mcp-bus`
`CustomEvent`s that `desktopBridge.js`'s SSE listener feeds into
`stateBus.receive()`. That is a faithful stand-in for the live MCP→SSE→bus path,
so it exercises the real React handlers without needing Claude Desktop running.
(The *full* loop — real SSE delivery + the live MCP tools like `describe_data`,
`list_stories`, `save_view` — still warrants a one-time smoke test in the actual
Claude Desktop + GridSight desktop setup, since a running MCP subprocess only
picks up server-side tool changes after it reconnects.)

Use the `Bash` tool for the stack + backend checks and the `preview_*` tools for
the browser. Report results per group as a ✅/❌ checklist; on ❌, read the
relevant source and diagnose before moving on.

---

## Setup (once per run)

1. **Start the dev stack** from the **main repo** (not a worktree — a worktree
   checkout serves stale code):
   ```bash
   # --git-common-dir resolves to the main checkout even from inside a worktree
   cd "$(git rev-parse --path-format=absolute --git-common-dir)/.." && ./dev.sh > /tmp/gridsight-dev.log 2>&1 &
   ```
   Wait until the backend answers:
   ```bash
   curl -s --retry 40 --retry-all-errors --retry-delay 2 --max-time 5 \
     -o /dev/null -w "backend HTTP %{http_code}\n" \
     -H "X-MyApp-ApiKey: dev-api-key" http://127.0.0.1:5001/api/extensions
   ```
   Expect `HTTP 200`. The stack is backend `:5001`, bun proxy `:3001`, vite `:5173`.

2. **(Optional) repoint the MCP backend descriptor** so connected MCP tools hit
   the dev backend instead of a dead desktop port:
   ```bash
   printf '{\n  "port": 5001,\n  "apiKey": "dev-api-key"\n}\n' \
     > "$HOME/Library/Application Support/gridsight/backend.json"
   ```
   (The desktop app rewrites this on its next launch — harmless.)

3. **Open the app in the preview browser.** Register/start the dev server then
   navigate to **`:5173`** (the main-repo vite). A `gridsight-web` launch config
   may start vite on `:5174`, but **`:5174` serves the worktree (wrong code)** —
   always navigate the page to `http://localhost:5173/`.
   ```
   preview_start  name=gridsight-web
   preview_eval   expression: window.location.href = 'http://localhost:5173/'
   ```
   If a login form appears, fill `admin` / `changeme` and submit
   (`preview_fill` / `preview_click button[type="submit"]`).

4. **Confirm you're on the right code** — the `mcp` channel subscriber must exist
   (proves the live App handler is loaded):
   ```js
   // preview_eval
   (async () => {
     const bus = (await import('/src/lib/stateBus.js')).default;
     const counts = {}; for (const c of bus._subscribers.keys()) counts[c] = bus._subscribers.get(c).size;
     return { hasMcp: bus._subscribers.has('mcp'), charts: counts.charts, viewport: counts.viewport };
   })()
   ```
   Expect `hasMcp: true`. If false, you're on the wrong port/checkout — fix before testing.

5. **The `fire()` harness** — paste this preamble into any `preview_eval` that
   sends bus messages. It builds the same envelope the SSE bridge delivers
   (`sourceId:'mcp'`, `force:true`, unique seq/timestamp):
   ```js
   let __n = Date.now();
   const fire = (channel, payload) => window.dispatchEvent(new CustomEvent('gridsight:mcp-bus', {
     detail: { channel, action: 'update', payload, sourceId: 'mcp', timestamp: __n++, seq: __n, force: true }
   }));
   ```

---

## Group A — Backend + MCP transport

**Preconditions:** stack up (Setup 1). No browser needed. Touches `routes/ai.py`,
`mcp_server.py`, `lib/sync.py`, the SEDS extension.

Run with `Bash` (`B=http://127.0.0.1:5001; H="X-MyApp-ApiKey: dev-api-key"`). Put
SQL in a file (`curl -d @file`) to avoid shell-quote mangling of inner `'...'`.

- [ ] **Capabilities** — `curl -s -H "$H" "$B/api/ai/capabilities"` → `extensions[]`
      includes `seds` with `tables[].columns` and `controls` (`fuel/sector/unit/year`).
- [ ] **Query** — `POST /api/query` with
      `{"sql":"SELECT state_code, value FROM ext_seds.data WHERE msn='ESTCB' AND year=2020 AND state_code<>'US' ORDER BY value DESC LIMIT 5","format":"json"}`
      → rows, TX highest (~1.46M).
- [ ] **Chart build+inject** — `POST /api/ai/chart` with a `line` chart over
      `ext_seds.data` → `{"sent":N,"title":...,"format":"plotly"}`, HTTP 200.
      (`sent:0` is fine when no display is subscribed.)
- [ ] **Memory save** — `POST /api/memory` → `{"success":true,"memory_id":...}`.
- [ ] **Memory search** — `GET /api/memory/search?query=<tag>` → finds it.
- [ ] **Lists** — `GET /api/stories` and `GET /api/perspectives` → arrays (200).
- [ ] **MCP tools** (if connected): `mcp__gridsight__query_data`,
      `mcp__gridsight__create_chart` → return live rows / "Opened chart … on N display(s)".

---

## Group B — Map viewport

**Preconditions:** Setup done; app on `:5173`. Touches `mcp_server.py`
(`pan_map`, `fit_map_to_bounds`), `BusSyncHost.jsx` + `MapPanel.jsx` viewport handlers.

- [ ] **Fit to bounds** — `fire('viewport', { bounds:{w:-106.65,s:25.84,e:-93.51,n:36.5}, fit:true, latitude:31.17, longitude:-100.08 })`;
      wait ~1.8s; `preview_screenshot` → map framed on **Texas**.
      (Regression guard: the `fit:true` flag must force the bounds path even
      though the viewport-sync "fit bounds" toggle defaults off.)
- [ ] **Pan/zoom** — `fire('viewport', { latitude:47.6, longitude:-122.3, zoom:7 })`
      → map flies to the Seattle area.

---

## Group C — Chart open + layout

**Preconditions:** Setup done. Touches `BusSyncHost.jsx` (chart:open-ai),
`useChartFrameRenderers.jsx` (cascade), `ChartFrame.jsx` / `ResizableChartContainer.jsx`
/ `ChartTabs.jsx` (resize).

Open three charts:
```js
for (let i=1;i<=3;i++) fire('charts', {
  type:'chart:open-ai',
  spec:{ sql:'SELECT 1', chart_type:'bar', x_column:'x', y_column:'y', title:'Chart '+i, datasets:[] },
  datasets:[], plotlySpec:{ data:[{type:'bar',x:['CA','TX','FL'],y:[3,2,i]}], layout:{title:{text:'Chart '+i}} },
  format:'plotly', anchorMode:'floating'
});
```
Then inspect:
```js
(() => {
  const resizeEls = [...document.querySelectorAll('div,span')].filter(e => getComputedStyle(e).cursor === 'nwse-resize');
  const plots = [...document.querySelectorAll('.js-plotly-plot')];
  const rects = plots.map(p => { const r = p.getBoundingClientRect(); return { left:Math.round(r.left), top:Math.round(r.top) }; });
  return { plots: plots.length, totalResizeHandles: resizeEls.length, rects };
})()
```
- [ ] **Renders** — `plots === 3`, titles Chart 1/2/3 visible.
- [ ] **Cascade (not stacked)** — successive `rects` offset by ~56px in x AND y
      (e.g. 240/100 → 296/156 → 352/212). A 30px (old) or 0px step is a regression.
- [ ] **Single resize handle** — `totalResizeHandles === 3` (one per chart). `6`
      means the redundant inner `ResizableChartContainer` handle is back (the
      `embedded`/`framed` fix regressed).

---

## Group D — Chart bulk ops

**Preconditions:** Group C charts open. Touches `BusSyncHost.jsx` +
`useChartFrames.js` (`chart:reanchor-all`, `chart:close-all`), anchor normalization.

- [ ] **Arrange → right** — `fire('charts', { type:'chart:reanchor-all', anchorMode:'right' })`;
      wait ~1.2s. All plots' `getBoundingClientRect().left` cluster near the right
      edge (e.g. all ≈ 0.74·innerWidth), aligned (docked), not cascaded.
      `preview_screenshot` → right-side column.
      (Regression guard: canonical `right`/`left` must normalize to
      `side-right`/`side-left` in **both** `BusSyncHost` and `useChartFrames`,
      or AI charts silently fall back to floating.)
- [ ] **Close all** — `fire('charts', { type:'chart:close-all' })`; wait ~1s →
      `document.querySelectorAll('.js-plotly-plot').length === 0`.

---

## Group E — Stories / perspectives / memory (agent learning)

**Preconditions:** Setup done. Touches App.jsx `mcp` channel handler,
`routes/perspectives.py`, `mcp_server.py` (`save_view`, `apply_perspective`, …).

- [ ] **Save current view** — `fire('mcp', { type:'capture-perspective', name:'Test view', description:'desc', storyName:'Test view' })`;
      wait ~1.8s. Then `Bash`:
      `GET /api/perspectives` → a perspective with non-empty `config_json` (the
      captured live-state blob, not `{}`); `GET /api/stories` → a story;
      `GET /api/stories/<id>/steps` → one step linking the perspective.
- [ ] **Apply perspective** — move the map elsewhere (Group B fit→Texas), then
      `fire('mcp', { type:'apply-perspective', perspectiveId:<id> })`; wait ~2s;
      `preview_screenshot` → map returns to the saved view.
- [ ] **Apply story** — `fire('mcp', { type:'apply-story', storyId:<id> })` →
      app enters story-playback mode.

---

## Cleanup

- Charts/perspectives created during a run persist in `../data/gridsight.db`.
  Delete test artifacts via `DELETE /api/perspectives/<id>` and
  `DELETE /api/stories/<id>` if you don't want them lingering.
- Leave the dev stack running for iterative testing, or `./dev.sh clean` to free
  ports `5001/3001/5173`.

---

## Adding a new interaction to the list

When you build a new `stateBus`-driven interaction (a new channel/message type,
a new MCP control tool, a new chart behavior):

1. Add a checklist item to the **most relevant group** (or create a new group if
   it's a distinct subsystem). Keep groups independent — state each group's
   preconditions so it can run alone.
2. Give the regression guard: one line on *what specifically breaks it* (the
   prop, flag, or vocab mismatch), so a failure points straight at the cause.
3. Provide a copy-pasteable `fire(...)` snippet (or `curl`) and the concrete
   expected result (DOM assertion, row shape, or screenshot description).

## Known gotchas

- **Port `5174` vs `5173`** — the `gridsight-web` preview config starts vite from
  the worktree on `:5174`; that serves a different branch. Always test on
  `:5173` (main-repo dev.sh). Verify with the `hasMcp` check (Setup 4).
- **Stale MCP subprocess** — a long-lived MCP connection keeps the tool set and
  server code it started with; new tools/edits to `mcp_server.py` need a
  reconnect (restart the MCP server in Claude Desktop). The HTTP endpoints it
  calls are picked up immediately by the running backend, though.
- **Anchor vocabulary** — frames and AI charts dock by `side-right`/`side-left`/
  `bottom`/`tray`/`floating`; external callers use canonical `right`/`left`,
  normalized in the frontend handlers. A new docking path must normalize too.
- **`logViewport` is quiet by default** — absence of a `viewport receive` console
  log doesn't mean the message was dropped; assert via map movement instead.

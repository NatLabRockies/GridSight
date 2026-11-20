# Building the Meridian Desktop App

Self-contained, single-binary builds of Meridian for individual users on
macOS, Windows, and Linux. The output is a standard installer / app bundle
that ships with its own Python sidecar and `uv`-managed venv — no Python,
Node, or backend setup required on the end user's machine.

> This is the per-host workflow. CI/CD is out of scope for now.

---

## What gets built

A Tauri 2 app whose webview loads the React frontend and whose Rust shell
spawns a Python (`uvicorn`) sidecar as a child process. The bundle includes:

| Resource | Source | Notes |
|---|---|---|
| `resources/server/` | `meridian/server/` | Frozen copy of the FastAPI app |
| `resources/wheels/` | `sdk/`, `GAT/`, `GAT/meridian-ext/` | Locally-built wheels for sibling packages |
| `resources/requirements.txt` | `server/pyproject.toml` (via `uv export`) | Pinned PyPI deps, local packages stripped |
| `binaries/uv` (or `uv.exe`) | astral-sh release | Used at first launch to provision the venv |
| Webview UI | `web/dist/` | Built by `bun run build` via Tauri's `beforeBuildCommand` |

At first launch the app uses the bundled `uv` to materialize a venv in the
user's OS cache directory, installing from `requirements.txt` + the bundled
wheels. Subsequent launches reuse the venv.

---

## Output locations

| Host | Artifact |
|---|---|
| macOS | `desktop/src-tauri/target/release/bundle/dmg/Meridian_<ver>_<arch>.dmg` and `…/macos/Meridian.app` |
| Windows | `desktop\src-tauri\target\release\bundle\nsis\Meridian_<ver>_x64-setup.exe` (+ MSI alongside) |
| Linux | `desktop/src-tauri/target/release/bundle/deb/meridian_<ver>_amd64.deb` and `…/appimage/Meridian_<ver>_amd64.AppImage` |

---

## Prerequisites (all hosts)

You must build on the same OS you're targeting. Tauri does not
cross-compile; a macOS host produces a `.dmg`, a Windows host produces an
`.exe`, etc.

- **Rust** stable toolchain via [rustup](https://rustup.rs)
- **Bun** ([install](https://bun.sh)) — frontend build + dev server
- **Git** with access to the Meridian and sibling repos checked out side by side:
  ```
  ~/code/meridian/        ← this repo
  ~/code/GAT/             ← GAT repo (contains gat/ and meridian-ext/)
  ```
  Paths can be overridden via `MERIDIAN_REPO` / `GAT_SOURCE_DIR` env vars
  when running `prepare-resources.sh`.

The build pulls `uv` from the official release archive automatically; you
do **not** need uv on PATH (though it's fine if it's there).

### macOS-specific

- Xcode Command Line Tools: `xcode-select --install`

### Windows-specific

- **Visual Studio 2022 Build Tools** with the "Desktop development with
  C++" workload (provides the MSVC linker Cargo needs).
- **WebView2 Runtime** — almost always already present on Windows 10/11.
  The installer we produce bootstraps it on machines that lack it.
- Build in a shell that has `bash` available (Git Bash, PowerShell with
  Git for Windows, or WSL). The prep script and `fetch-uv.sh` are POSIX
  shell scripts.

### Linux-specific (Debian/Ubuntu)

Install Tauri's system dependencies:

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```

(For RHEL/Fedora and Arch, see the
[Tauri prereq docs](https://tauri.app/start/prerequisites/).)

---

## One-time setup

From inside `desktop/`:

```bash
cd desktop
bun install                          # Tauri CLI + a couple of devDeps
bun run fetch-uv                     # downloads uv into src-tauri/binaries/
```

`fetch-uv` reads `uname` and pulls the right `uv` binary for the host. Run
it once; rerun only when you want to bump `UV_VERSION` (set the env var
when invoking).

---

## Building a release

```bash
cd desktop
bun run build
```

This runs, in order:

1. `scripts/prepare-resources.sh` — freezes the server source, exports
   `requirements.txt`, and builds wheels for the local sibling packages.
2. `cd ../web && bun run build` (Tauri `beforeBuildCommand`) — builds the
   React SPA into `web/dist/`.
3. `tauri build` — compiles the Rust shell in release mode and packages
   it with the resources into platform-native installers.

Expect 5–15 minutes on a cold cache, mostly Rust release codegen.

### Building specific targets

`tauri.conf.json` has `bundle.targets: "all"`, so by default Tauri
produces every installer kind your host supports (e.g. on Linux: `.deb`
and AppImage). Narrow it from the CLI when you only want one:

```bash
bun run tauri build -- --bundles dmg          # macOS only
bun run tauri build -- --bundles nsis,msi     # Windows
bun run tauri build -- --bundles deb,appimage # Linux
```

### Architecture (Apple Silicon vs Intel)

By default the bundle matches the host architecture. To target the other:

```bash
# On Apple Silicon, build for Intel Macs:
rustup target add x86_64-apple-darwin
bun run tauri build -- --target x86_64-apple-darwin
```

You'll also need to rerun `fetch-uv` on a host of that arch, or fetch the
matching `uv` manually into `src-tauri/binaries/`.

---

## Running the dev build instead

For day-to-day development you usually don't want to bundle anything:

```bash
cd desktop
bun run dev
```

This launches Tauri in dev mode (with HMR via Vite), runs the local
`server/` source through `uv sync` against editable sibling packages, and
writes logs to `~/Library/Logs/Meridian/backend.log` (macOS) or the OS
equivalent on other platforms. Code edits to either the React app or the
Python server (and its sibling extensions) are picked up live — no
rebuild needed.

`cfg!(debug_assertions)` forces dev mode in debug builds even when stale
bundled resources happen to exist in `target/`. Release builds always use
the bundled path.

---

## Where the app puts things on user machines

| Platform | Logs | Data | Cache (venv) |
|---|---|---|---|
| macOS | `~/Library/Logs/Meridian/` | `~/Library/Application Support/Meridian/` | `~/Library/Caches/Meridian/` |
| Linux | `~/.cache/Meridian/Logs/` | `~/.local/share/Meridian/` | `~/.cache/Meridian/` |
| Windows | `%LOCALAPPDATA%\Meridian\Logs\` | `%APPDATA%\Meridian\` | `%LOCALAPPDATA%\Meridian\` |

Uninstall does not remove these directories. To fully reset a user's
install, delete the three paths above.

---

## Troubleshooting

**`uv binary not found` from `prepare-resources.sh`**
Run `bun run fetch-uv` first, or set `UV=/path/to/uv` and rerun.

**Build succeeds but the app shows a blank window**
The webview probably failed to load `web/dist/`. Check that
`beforeBuildCommand` ran — `web/dist/index.html` should exist. Force a
rebuild: `cd web && bun run build`.

**First launch sits on "Provisioning…" for a long time**
That's `uv` building wheels for the bundled requirements (DuckDB, pyarrow,
polars). Cold path is 1–3 minutes on a typical laptop. Subsequent launches
are instant.

**Sidecar dies during use**
The Rust watchdog auto-respawns it within ~3 s. Look for
`watchdog: sidecar exited (<status>)` in `backend.log` to see the exit
code — `137` is OOM, `1` is a Python exception, `139` is a SIGSEGV.

**Stale bundled resources getting picked up in `bun run dev`**
Shouldn't happen any more (debug builds force dev mode), but if you
suspect it, `rm -rf desktop/src-tauri/target/debug/resources` and rerun.

**Need to wipe the dev venv and start over**
```bash
rm -rf ~/Library/Caches/Meridian/venv      # macOS
rm -rf ~/.cache/Meridian/venv              # Linux
# Windows: delete %LOCALAPPDATA%\Meridian\venv
```
Next launch reprovisions from scratch.

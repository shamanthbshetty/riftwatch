# RiftWatch

Watch anime, movies & TV shows.

## Prerequisites

- Node.js 22+ — [https://nodejs.org](https://nodejs.org)

### Install Node.js

**Windows:**
```powershell
winget install OpenJS.NodeJS.LTS
```

**Linux (Debian/Ubuntu):**
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

## Setup

```bash
npm run dev
```

This auto-installs all dependencies on first run, auto-builds the Rust backend
(debug profile) if its binary is missing, and frees ports 3000/3001 if they are
already in use. It prints a health line once the backend and frontend are up.

Add `--open` (or use `npm run dev:open`) to launch your browser automatically.

### Other commands

```bash
npm run check       # lint + typecheck in parallel
npm run build:rust  # release build of the Rust backend
npm run stop        # kill both dev servers (Windows/macOS/Linux)
```

## Desktop app (Tauri v2)

The web app is unchanged; the desktop build wraps it in a native window and
runs the existing Rust backend as a bundled sidecar.

**Prerequisites:** Node.js 22+, a Rust toolchain, and on Windows the WebView2
runtime (preinstalled on Windows 10/11).

```bash
npm run dev:tauri   # build the sidecar, then launch Tauri in dev mode
npm run tauri:build # build the installer (MSI + NSIS)
```

`npm run dev:tauri` opens a native window against the running Next dev server
(`http://localhost:3000`), so hot reload works. The production window uses a
`riftwatch://` custom protocol over the bundled static export. Next static
export can only emit one file per dynamic route, so those pages are built as
`_` placeholders (`anime/_.html`, `watch/_.html`, ...); the protocol serves the
placeholder for any id and the client reads the real id from the URL.

`npm run tauri:build` produces the installers under
`src-tauri/target/release/bundle/`. On Windows with the GNU Rust toolchain and a
checkout path containing spaces, the script redirects Cargo to
`C:\riftwatch-target\app` so `windres` can handle the path; the installers are
then under `C:\riftwatch-target\app\release\bundle\`.

The desktop app keeps using `localStorage` for history, watchlists, settings and
resume positions, so existing data in the webview is preserved.

### Backend configuration

The Rust backend reads `.env.local` from its working directory. The desktop app
runs it from the per-user config folder:

- Windows: `%APPDATA%\com.riftwatch.app\.env.local`
- macOS: `~/Library/Application Support/com.riftwatch.app/.env.local`
- Linux: `~/.config/com.riftwatch.app/.env.local`

When you launch the app from the repository (including `npm run dev:tauri`), the
file is copied there automatically on first run. For an installed app, create
it manually with at least `TMDB_API_KEY` (see `.env.local` in the repo for the
other optional provider settings).

### Updates

The app checks the GitHub Releases `latest.json` on startup and offers to
install a newer signed build. Releases are built by
`.github/workflows/desktop-release.yml` when a `v*` tag is pushed (or manually
via workflow dispatch).

Signing keys live in `src-tauri/keys/` and are gitignored. To use the updater
locally, keep `riftwatch.key` and `riftwatch.key.password` there; the build
script signs the update artifacts automatically. For GitHub Actions, add:

- `TAURI_SIGNING_PRIVATE_KEY` — contents of `riftwatch.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — contents of `riftwatch.key.password`

The public key is committed in `src-tauri/tauri.conf.json`. Losing the private
key means existing installs cannot verify future updates, so back it up.

`tauri-action` uploads the NSIS installer, its `.sig` file and a generated
`latest.json`. The release workflow creates a **draft** release. Publish it to
make `releases/latest/download/latest.json` point at the new version.


## Environment

Create `.env.local` with your TMDB API key:
```
TMDB_API_KEY=your_key_here
```

# RiftWatch

Watch anime, movies & TV shows. **Desktop-only** — the frontend ships as a
static export inside a Tauri v2 app; there is no web deployment.

## Features

- Anime and movie/TV discovery, search with filters (genre, year, score, status, dub),
  watchlists, history, notifications, resume positions, and theming.
- Video player with subtitles, auto-skip for openings/endings, speed/quality controls,
  and keyboard shortcuts (space/K play, J/K/L seek, arrows, N/P episodes, F fullscreen,
  number keys jump by 10%). Windows media keys are supported too.
- Settings → **What's New** shows the latest GitHub release notes; auto-updates are signed.
- Rolling local backups (newest 5) plus manual Export/Import in Settings.
- Remembers window size/position, with a **Reset window** button in Settings.
- "Save offline" stores direct MP4 streams under `%APPDATA%\com.riftwatch.app\downloads`.
  HLS streams are playlists plus many segments and are not supported for offline saving.

## Prerequisites

- Node.js 22+ — [https://nodejs.org](https://nodejs.org)
- A Rust toolchain (for the backend sidecar and the Tauri app)
- Windows 10/11 with WebView2 (preinstalled)

```powershell
winget install OpenJS.NodeJS.LTS
```

## Development

```bash
npm run dev         # build the sidecar, then launch the Tauri dev window
npm run check       # lint + typecheck in parallel
npm run build:rust  # release build of the Rust backend
npm run tauri:build # build the installer (MSI + NSIS)
```

`npm run dev` opens a native window against the Next dev server
(`http://localhost:3000`) so hot reload works while developing. The production
build uses a `riftwatch://` custom protocol over the bundled static export.

`npm run tauri:build` produces the installers under
`src-tauri/target/release/bundle/`. On Windows with the GNU Rust toolchain and a
checkout path containing spaces, the script redirects Cargo to
`C:\riftwatch-target\app` so `windres` can handle the path; the installers are
then under `C:\riftwatch-target\app\release\bundle\`.

## How it works

- The Rust backend starts as a sidecar with `PORT=0`; the OS picks a free port
  and the app reads `RIFTWATCH_PORT=` from its stdout. All `/api/*` requests are
  rewritten to that port.
- Next static export can only emit one file per dynamic route, so those pages
  are built as `_` placeholders (`anime/_.html`, `watch/_.html`, ...). The
  custom protocol serves the placeholder for any id and the client reads the
  real id from the URL.
- History, watchlists, settings and resume positions are stored in the webview's
  `localStorage`, so data survives app updates.

## Backend configuration

The Rust backend reads `.env.local` from its working directory. The desktop app
runs it from the per-user config folder:

- Windows: `%APPDATA%\com.riftwatch.app\.env.local`
- macOS: `~/Library/Application Support/com.riftwatch.app/.env.local`
- Linux: `~/.config/com.riftwatch.app/.env.local`

When you launch the app from the repository (including `npm run dev`), the file
is copied there automatically on first run. For an installed app, create it
manually with at least `TMDB_API_KEY`:

```
TMDB_API_KEY=your_key_here
```

## Updates

The app checks GitHub Releases `latest.json` on startup and offers to install a
newer signed build. Releases are built by
`.github/workflows/desktop-release.yml` when a `v*` tag is pushed (or manually
via workflow dispatch).

Signing keys live in `src-tauri/keys/` and are gitignored. Keep
`riftwatch.key` and `riftwatch.key.password` there for local signed builds, and
add these GitHub Actions secrets for CI:

- `TAURI_SIGNING_PRIVATE_KEY` — contents of `riftwatch.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — contents of `riftwatch.key.password`

The public key is committed in `src-tauri/tauri.conf.json`. Losing the private
key means existing installs cannot verify future updates, so back it up.

`tauri-action` uploads the NSIS installer, its `.sig` file and a generated
`latest.json`. The release workflow creates a **draft** release. Publish it to
make `releases/latest/download/latest.json` point at the new version.

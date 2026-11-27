# RiftWatch Native (work in progress)

A native Rust rewrite of RiftWatch. It does not use Tauri, a webview, Next.js,
or JavaScript. It talks to the existing Axum backend as a sidecar over HTTP.

## Build & run

```bash
npm run build:rust                        # builds rust-backend/target/release/riftwatch-backend.exe
# Put the Windows portable mpv build in native-app/bin/mpv/mpv.exe (gitignored):
#   https://github.com/shinchiro/mpv-winbuild-cmake/releases/latest  ->  mpv-x86_64-*.7z
cargo build --release --manifest-path native-app/Cargo.toml
./native-app/target/release/riftwatch-native.exe
```

The app starts the backend with `PORT=0` and `RIFTWATCH_BIND=127.0.0.1`, reads
`RIFTWATCH_PORT=<port>` from stdout, and uses that port for all API calls.

## Implemented

- Native iced window (Phase 1): sidecar spawn, dynamic port handshake.
- API client, data models, and JSON-file persistence under
  `%APPDATA%\com.riftwatch.app\native\data.json` (Phase 2).
- Tabbed UI (Phase 3): Home (trending/popular), Search, show detail with episode
  list, Watchlist, History, Settings. Search results and home rails are clickable;
  opening a show fetches its episodes from `/api/episodes`.

## Not implemented yet

- **Video playback** works by launching the bundled `mpv.exe` with a resolved
  stream URL and subtitle files. mpv is an external binary (not pure Rust).
- Movie/TV pages, skip intervals, notifications, and the full visual design of
  the current Tauri app are not ported yet.

Measured idle working set: native app + backend ≈ **180 MB** vs Tauri app +
WebView2 processes ≈ **570 MB**. During HLS playback mpv adds roughly **260 MB**
private memory, so playback is comparable to Tauri but startup and idle are much
lighter.

Until video playback is solved, the Tauri build remains the complete, shippable
app (`npm run tauri:build`).

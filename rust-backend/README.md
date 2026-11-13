# riftwatch-backend (Rust)

Phase 1 of the Rust migration: the byte-heavy proxy layer (m3u8/mp4/subtitle/generic proxy) moved out of Next.js into a small Axum service.

## Build
```sh
cd rust-backend
cargo build --release
```
Binary: `target/release/riftwatch-backend` (~4.5 MB stripped).

## Run
```sh
# from repo root
./rust-backend/target/release/riftwatch-backend   # listens on :3001
npm run dev                                       # Next.js on :3000, rewrites proxy routes to Rust
```
Set `PORT=...` and `RUST_PROXY_URL=...` in `.env` to point Next at a remote Rust instance.

## Routes
- `GET /health` -> `{ "ok": true }`
- `GET /api/movies/m3u8-proxy?url=...&referer=...&origin=...`
- `GET /api/movies/mp4-proxy?url=...`
- `GET /api/movies/subtitle-proxy?url=...&referer=...`
- `GET /api/proxy?src=...&referer=...`

## Phase 2 (TODO)
Port scraping/resolution routes (stream, episodes, search, schedule, details, ...) to Rust.

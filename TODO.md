# RiftWatch — feature todo list

Trackable in-repo checklist for the feature batch requested 2026-11-18.

## In progress

- [x] #2 Trailers — TMDB `videos()` + AniList trailer route; Trailer button + YouTube modal on `/anime/[id]` and `/movies/[id]` (verified in browser)
- [x] #3 You might like — recommendations rail (AniList `Media.recommendations`), excludes already-watched shows, hidden when history empty (verified in browser)
- [~] #7 Download queue — existing "Download from X" link when provider supplies `downloads.downloadUrl`; full HLS segment assembly not feasible (sources are embed pages, not direct HLS) — left as provider link

## Verification

- [x] Related anime rail still works (2 cards on Quintuplets page)
- [x] Theme toggle (Nav + Ctrl+K) still works; light-theme visual audit (toggle verified; tokens exist; not visually screenshotted)
- [x] `npx tsc --noEmit` clean
- [x] `npm run lint` clean
- [x] Rust `cargo build --release` compiles
- [x] Restart dev servers; smoke-test in browser (trailers + because-you-watched verified)
- [ ] Commit & push (user confirms)

## Done

- [x] Title scoring fix — FORMAT words in `score_title` (`base_score` + format wrapper); movie 2:16:04 runtime, distinct stream hash
- [x] Rail drag — threshold 10px, `setTimeout(50ms)` reset, removed `setPointerCapture`, window-level pointermove/up, no custom cursor, momentum scroll
- [x] Design tokens / `MediaCard` / `SectionHeader` / full-width home / stacked layout
- [x] Quintuplets movie vs TV fix (verified in browser)
- [x] Export/import — extended `exportData`/`importData` to cover resume positions, playback prefs, ep-cache, tv-ep-cache, theme
- [x] Spinner arrows removed on number inputs (`input[type="number"]` spin buttons hidden via `globals.css`)
- [x] Related anime rail verified working (2 cards on `/anime/103572` via `malId=38101`)
- [x] Theme toggle verified working (Nav button + Ctrl+K → `data-theme="light"`)
- [x] Committed & pushed `14f61c2`; working tree clean

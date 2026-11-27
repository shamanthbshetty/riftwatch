use std::sync::Mutex;
use tauri::http::{header, Response, StatusCode};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Position, RunEvent, Size,
    WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_shell::{process::CommandChild, ShellExt};
use tauri_plugin_updater::UpdaterExt;

struct BackendChild(Mutex<Option<CommandChild>>);
struct BackendPort(Mutex<Option<u16>>);

fn asset_response(asset: tauri::Asset) -> Response<Vec<u8>> {
    Response::builder()
        .header(header::CONTENT_TYPE, asset.mime_type)
        .header(header::CACHE_CONTROL, "no-cache")
        .body(asset.bytes)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn not_found() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(header::CONTENT_TYPE, "text/plain")
        .body(b"Not found".to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// Tauri's asset resolver falls back to `index.html` for *every* unknown path
/// (its SPA fallback). For dynamic routes that means the first candidate would
/// serve the home page instead of the `_` placeholder. Compare against the real
/// index asset and treat it as a miss so the next candidate gets a chance.
fn get_exact_asset<R: tauri::Runtime>(
    resolver: &tauri::AssetResolver<R>,
    candidate: &str,
    index: Option<&tauri::Asset>,
) -> Option<tauri::Asset> {
    resolver.get(candidate.to_string()).filter(|asset| {
        candidate == "index.html" || index.map_or(true, |i| i.bytes != asset.bytes)
    })
}

/// Resolves a path from the bundled static export.
///
/// Next.js static export can only emit one file per dynamic route, so this app
/// builds them with a `_` placeholder (`anime/_.html`, `movies/_/watch.html`).
/// Any unknown id under those routes falls back to the placeholder file; the
/// client component reads the real id from the URL via `useRouteParam`.
fn resolve_asset(app: &AppHandle, request_path: &str) -> Option<tauri::Asset> {
    let resolver = app.asset_resolver();
    let path = request_path.trim_start_matches('/');
    if path.is_empty() {
        return resolver.get("index.html".to_string());
    }

    let index = resolver.get("index.html".to_string());
    let mut candidates = vec![path.to_string()];
    if !path.contains('.') {
        candidates.push(format!("{path}.html"));
        candidates.push(format!("{path}/index.html"));
    }

    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segments.len() >= 2 {
        let mut fallback = segments.clone();
        fallback[1] = "_";
        candidates.push(format!("{}.html", fallback.join("/")));
    }

    candidates
        .into_iter()
        .find_map(|candidate| get_exact_asset(&resolver, &candidate, index.as_ref()))
}

/// Next's client router asks for `.txt` RSC payloads. Static routes have them;
/// dynamic placeholders do not, so the router falls back to a full page load
/// (which `resolve_asset` can serve). The index fallback must be filtered here
/// too, otherwise an RSC request would receive HTML instead of a 404.
fn resolve_rsc_asset(app: &AppHandle, request_path: &str) -> Option<tauri::Asset> {
    let resolver = app.asset_resolver();
    let path = request_path.trim_start_matches('/').trim_end_matches('/');
    let candidates = if path.is_empty() {
        vec!["index.txt".to_string()]
    } else {
        vec![format!("{path}.txt"), format!("{path}/index.txt")]
    };
    let index = resolver.get("index.html".to_string());
    candidates
        .into_iter()
        .find_map(|candidate| get_exact_asset(&resolver, &candidate, index.as_ref()))
}

fn handle_asset_request(app: &AppHandle, request: &tauri::http::Request<Vec<u8>>) -> Response<Vec<u8>> {
    let path = request.uri().path();
    let wants_rsc = request
        .uri()
        .query()
        .is_some_and(|query| query.contains("_rsc="))
        || request.headers().contains_key("RSC");

    if wants_rsc {
        return resolve_rsc_asset(app, path)
            .map(asset_response)
            .unwrap_or_else(not_found);
    }

    resolve_asset(app, path)
        .map(asset_response)
        .unwrap_or_else(not_found)
}


/// Copies a `.env.local` from the checkout (or next to the executable) into the
/// per-user config dir the first time the desktop app runs. Installed users can
/// also drop the file there manually.
fn seed_env_file(config_dir: &std::path::Path) {
    let dest = config_dir.join(".env.local");
    if dest.exists() {
        return;
    }

    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.clone());
        if let Some(parent) = cwd.parent() {
            candidates.push(parent.to_path_buf());
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(|p| p.to_path_buf());
        for _ in 0..5 {
            let Some(current) = dir else { break };
            candidates.push(current.clone());
            dir = current.parent().map(|p| p.to_path_buf());
        }
    }

    for dir in candidates {
        let src = dir.join(".env.local");
        if src.exists() {
            let _ = std::fs::copy(&src, &dest);
            return;
        }
    }
}


/// Spawns the Rust backend sidecar and watches its stdout for the port marker.
///
/// The backend is started with `PORT=0` so the OS assigns a free port; this
/// avoids clashing with a stale backend or a dev server on 3001. The frontend
/// asks for the port through the `get_backend_port` command.
fn spawn_backend(app: &AppHandle) -> Result<CommandChild, Box<dyn std::error::Error>> {
    let mut command = app.shell().sidecar("riftwatch-backend")?;

    // The backend reads `.env.local` from its working directory. In the
    // desktop app that is the per-user config dir. Seed it from the repo the
    // first time the app runs from a checkout, then let the user edit it.
    if let Ok(config_dir) = app.path().app_config_dir() {
        let _ = std::fs::create_dir_all(&config_dir);
        seed_env_file(&config_dir);
        command = command.current_dir(&config_dir);
    }

    command = command.env("PORT", "0").env("RIFTWATCH_BIND", "127.0.0.1");

    let (mut rx, child) = command.spawn()?;

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    if let Some(port) = line.trim().strip_prefix("RIFTWATCH_PORT=") {
                        if let Ok(port) = port.parse::<u16>() {
                            if let Some(state) = handle.try_state::<BackendPort>() {
                                *state.0.lock().unwrap() = Some(port);
                            }
                        }
                    }
                }
                CommandEvent::Terminated(_) => break,
                _ => {}
            }
        }
    });

    Ok(child)
}

fn kill_backend(app: &AppHandle) {
    if let Some(state) = app.try_state::<BackendChild>() {
        if let Some(child) = state.0.lock().unwrap().take() {
            let _ = child.kill();
        }
    }
}

#[tauri::command]
fn get_backend_port(state: tauri::State<BackendPort>) -> Option<u16> {
    *state.0.lock().unwrap()
}

#[derive(serde::Serialize, serde::Deserialize)]
struct SavedWindow {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn window_state_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("window-state.json"))
}

fn restore_window_state(app: &AppHandle) {
    let Ok(bytes) = std::fs::read(window_state_path(app).unwrap_or_default()) else {
        return;
    };
    let Ok(saved) = serde_json::from_slice::<SavedWindow>(&bytes) else {
        return;
    };
    if let Some(window) = app.get_webview_window("main") {
        // We saved outer pixels; convert back to logical coordinates so DPI
        // scaling cannot inflate the window on restore.
        let _ = window.set_position(Position::Physical(PhysicalPosition {
            x: saved.x as i32,
            y: saved.y as i32,
        }));
        // `saved.width/height` are the logical *inner* size; set_size uses
        // inner dimensions too, so the window frame is added exactly once.
        let _ = window.set_size(Size::Logical(LogicalSize {
            width: saved.width,
            height: saved.height,
        }));
    }
}

fn save_window_state(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let saved = SavedWindow {
        x: position.x as f64,
        y: position.y as f64,
        width: size.width as f64 / scale,
        height: size.height as f64 / scale,
    };
    if let Ok(bytes) = serde_json::to_vec(&saved) {
        if let Ok(path) = window_state_path(app) {
            let _ = std::fs::write(path, bytes);
        }
    }
}

fn safe_download_name(filename: &str) -> String {
    filename
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect()
}

fn downloads_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("downloads");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn absolute_url(base: &str, reference: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(base).map_err(|e| e.to_string())?;
    parsed
        .join(reference)
        .map(|url| url.to_string())
        .map_err(|e| e.to_string())
}

/// Save a direct media stream (MP4) to the per-user downloads folder.
#[tauri::command]
async fn download_offline(app: AppHandle, url: String, filename: String) -> Result<String, String> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    let path = downloads_dir(&app)?.join(safe_download_name(&filename));
    let response = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("download failed: {}", response.status()));
    }
    let mut file = tokio::fs::File::create(&path).await.map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
    }
    file.flush().await.map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Download an HLS stream without any external tools: pick the best variant,
/// fetch every segment next to a rewritten local playlist. Encrypted streams
/// are rejected rather than producing a broken offline copy.
#[tauri::command]
async fn download_hls(app: AppHandle, url: String, filename: String) -> Result<String, String> {
    let safe = safe_download_name(&filename);
    let base = safe.strip_suffix(".mp4").unwrap_or(&safe).to_string();
    let root = downloads_dir(&app)?;
    let segment_dir = root.join(&base);
    std::fs::create_dir_all(&segment_dir).map_err(|e| e.to_string())?;
    let playlist_path = root.join(format!("{base}.m3u8"));

    let master = reqwest::get(&url)
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    if master.contains("#EXT-X-KEY") {
        return Err("encrypted HLS streams are not supported".to_string());
    }

    // Master playlist → choose the highest-bandwidth variant.
    let media_url = if master.contains("#EXT-X-STREAM-INF") {
        let mut best: Option<(u64, String)> = None;
        let mut bandwidth = 0u64;
        for line in master.lines() {
            let line = line.trim();
            if let Some(info) = line.strip_prefix("#EXT-X-STREAM-INF:") {
                bandwidth = info
                    .split(',')
                    .find_map(|part| part.trim().strip_prefix("BANDWIDTH="))
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
            } else if !line.is_empty() && !line.starts_with('#') {
                let candidate = (bandwidth, line.to_string());
                if best.as_ref().is_none_or(|b| candidate.0 > b.0) {
                    best = Some(candidate);
                }
            }
        }
        match best {
            Some((_, variant)) => absolute_url(&url, &variant)?,
            None => return Err("no playable variant in playlist".to_string()),
        }
    } else {
        url.clone()
    };

    let playlist = if media_url == url {
        master
    } else {
        reqwest::get(&media_url)
            .await
            .map_err(|e| e.to_string())?
            .text()
            .await
            .map_err(|e| e.to_string())?
    };
    if playlist.contains("#EXT-X-KEY") {
        return Err("encrypted HLS streams are not supported".to_string());
    }

    let mut local = String::from("#EXTM3U\n#EXT-X-VERSION:3\n");
    let mut index = 0usize;
    let mut last_info = String::new();
    for line in playlist.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("#EXTINF:") {
            last_info = trimmed.to_string();
        } else if trimmed.starts_with("#EXT-X-TARGETDURATION")
            || trimmed.starts_with("#EXT-X-MEDIA-SEQUENCE")
            || trimmed.starts_with("#EXT-X-PLAYLIST-TYPE")
        {
            local.push_str(trimmed);
            local.push('\n');
        } else if !trimmed.is_empty() && !trimmed.starts_with('#') {
            let segment_url = absolute_url(&media_url, trimmed)?;
            let bytes = reqwest::get(&segment_url)
                .await
                .map_err(|e| e.to_string())?
                .bytes()
                .await
                .map_err(|e| e.to_string())?;
            let name = format!("seg_{index:05}.ts");
            std::fs::write(segment_dir.join(&name), bytes).map_err(|e| e.to_string())?;
            if !last_info.is_empty() {
                local.push_str(&last_info);
                local.push('\n');
                last_info.clear();
            }
            local.push_str(&name);
            local.push('\n');
            index += 1;
        }
    }
    if index == 0 {
        return Err("playlist contained no segments".to_string());
    }
    local.push_str("#EXT-X-ENDLIST\n");
    std::fs::write(&playlist_path, local).map_err(|e| e.to_string())?;
    Ok(playlist_path.to_string_lossy().to_string())
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| e.to_string())
}

#[tauri::command]
fn reset_window(app: AppHandle) -> Result<(), String> {
    let _ = std::fs::remove_file(window_state_path(&app)?);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_size(Size::Logical(LogicalSize {
            width: 1180.0,
            height: 700.0,
        }));
        let _ = window.center();
        let _ = window.set_focus();
    }
    Ok(())
}

/// Periodic snapshot of the webview's localStorage export. Keeps the newest
/// five so a bad import or a crash never destroys the only copy.
#[tauri::command]
fn save_auto_backup(app: AppHandle, contents: String) -> Result<(), String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("backups");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    std::fs::write(dir.join(format!("auto-{stamp}.json")), contents)
        .map_err(|e| e.to_string())?;

    let mut snapshots: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("auto-") && n.ends_with(".json")))
        .collect();
    snapshots.sort();
    while snapshots.len() > 5 {
        let _ = std::fs::remove_file(snapshots.remove(0));
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .register_uri_scheme_protocol("riftwatch", |ctx, request| {
            handle_asset_request(ctx.app_handle(), &request)
        })
        .manage(BackendChild(Mutex::new(None)))
        .manage(BackendPort(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            get_backend_port,
            save_auto_backup,
            reset_window,
            open_external,
            download_offline,
            download_hls
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Restore the last window placement if we have one; otherwise
            // center it so it can never open behind the taskbar / off-screen.
            let has_saved_window = window_state_path(app.handle())
                .map(|p| p.exists())
                .unwrap_or(false);
            if has_saved_window {
                restore_window_state(app.handle());
            } else if let Some(window) = app.get_webview_window("main") {
                let _ = window.center();
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }

            // System media keys. The frontend turns these events into the same
            // actions as the player's keyboard shortcuts.
            let shortcut_handle = app.handle().clone();
            for (shortcut, event) in [
                ("MediaPlayPause", "rw-media-play-pause"),
                ("MediaNextTrack", "rw-media-next"),
                ("MediaPrevTrack", "rw-media-prev"),
            ] {
                let handle = shortcut_handle.clone();
                let name = event.to_string();
                if let Err(error) =
                    app.global_shortcut()
                        .on_shortcut(shortcut, move |_app, _shortcut, state| {
                            if state.state == ShortcutState::Pressed {
                                let _ = handle.emit(&name, ());
                            }
                        })
                {
                    log::debug!("could not register media shortcut {shortcut}: {error}");
                }
            }

            let child = spawn_backend(app.handle())?;
            if let Some(state) = app.try_state::<BackendChild>() {
                *state.0.lock().unwrap() = Some(child);
            }

            // Phase 8: check GitHub Releases once at startup for a signed update.
            // Skip in dev builds so a local `tauri dev` session is never asked to
            // replace itself with a released installer.
            if cfg!(debug_assertions) {
                log::debug!("skipping update check in debug builds");
                return Ok(());
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let updater = match handle.updater() {
                    Ok(updater) => updater,
                    Err(err) => {
                        log::debug!("updater unavailable: {err}");
                        return;
                    }
                };
                let update = match updater.check().await {
                    Ok(Some(update)) => update,
                    Ok(None) => return,
                    Err(err) => {
                        log::debug!("update check failed: {err}");
                        return;
                    }
                };

                let install = handle
                    .dialog()
                    .message(format!(
                        "RiftWatch {} is available. Install it now?",
                        update.version
                    ))
                    .title("Update available")
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "Install".to_string(),
                        "Later".to_string(),
                    ))
                    .blocking_show();

                if !install {
                    return;
                }

                // The Windows installer replaces files in place, so stop the
                // sidecar first or the relaunched app will find the port taken.
                kill_backend(&handle);
                if let Err(err) = update.download_and_install(|_, _| {}, || {}).await {
                    log::error!("update install failed: {err}");
                    // Bring the backend back so the app stays usable.
                    match spawn_backend(&handle) {
                        Ok(child) => {
                            if let Some(state) = handle.try_state::<BackendChild>() {
                                *state.0.lock().unwrap() = Some(child);
                            }
                        }
                        Err(err) => log::error!("failed to restart backend: {err}"),
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        match event {
            // The window is still alive here, so its position/size are valid.
            RunEvent::WindowEvent {
                event: WindowEvent::CloseRequested { .. },
                ..
            } => save_window_state(handle),
            RunEvent::Exit => {
                save_window_state(handle);
                kill_backend(handle);
            }
            _ => {}
        }
    });
}

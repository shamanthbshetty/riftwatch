use std::sync::Mutex;
use tauri::http::{header, Response, StatusCode};
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .register_uri_scheme_protocol("riftwatch", |ctx, request| {
            handle_asset_request(ctx.app_handle(), &request)
        })
        .manage(BackendChild(Mutex::new(None)))
        .manage(BackendPort(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![get_backend_port])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Always open fully on-screen and focused. Windows can restore a
            // stale position from a previous session, which sometimes puts the
            // window behind the taskbar or below the visible screen area.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.center();
                let _ = window.set_focus();
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
        if let RunEvent::Exit = event {
            kill_backend(handle);
        }
    });
}

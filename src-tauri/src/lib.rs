use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::default().build())
        .manage(BackendChild(Mutex::new(None)))
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Spawn the Rust backend as a sidecar (binds to port 3001)
            use tauri_plugin_shell::ShellExt;
            let sidecar = app
                .shell()
                .sidecar("riftwatch-backend")
                .expect("failed to create sidecar command");

            let (_rx, child) = sidecar
                .spawn()
                .expect("failed to spawn backend sidecar");

            app.manage(BackendChild(Mutex::new(Some(child))));

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<BackendChild>() {
                    if let Some(child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}

struct BackendChild(Mutex<Option<tauri_plugin_shell::process::CommandChild>>);
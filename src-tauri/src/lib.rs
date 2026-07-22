pub mod app_state;
pub mod capture;
pub mod commands;
pub mod control;
pub mod domain;
pub mod provider;
pub mod store;

use std::path::PathBuf;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use app_state::AppState;
use commands::{
    add_capture_marker, device_preflight, frida_preflight, get_capture_status, get_exchange,
    list_endpoints, page_exchanges, start_capture, stop_capture,
};
use provider::ProviderRuntime;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            #[cfg(unix)]
            std::fs::set_permissions(&app_data_dir, std::fs::Permissions::from_mode(0o700))?;
            let sessions_root = app_data_dir.join("sessions");
            std::fs::create_dir_all(&sessions_root)?;
            #[cfg(unix)]
            std::fs::set_permissions(&sessions_root, std::fs::Permissions::from_mode(0o700))?;
            let source_project =
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sidecars/ios-provider");
            let search_directories = std::env::current_exe()?
                .parent()
                .map(std::path::Path::to_path_buf)
                .into_iter()
                .collect::<Vec<_>>();
            let provider_runtime = ProviderRuntime::discover(&search_directories, source_project)?;
            app.manage(AppState::new(sessions_root, provider_runtime));
            let handle = app.handle().clone();
            let control_path = app_data_dir.join("control.sock");
            let control_service = app.state::<AppState>().live_capture.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) =
                    control::serve_local_control(control_path, control_service).await
                {
                    eprintln!("proxbot control bridge stopped: {error:#}");
                }
            });
            tauri::async_runtime::spawn(async move {
                let mut last_revision = u64::MAX;
                loop {
                    let service = handle.state::<AppState>().live_capture.clone();
                    let snapshot = service.status().await;
                    if snapshot.revision != last_revision {
                        last_revision = snapshot.revision;
                        let _ = handle.emit("capture://status", snapshot);
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_endpoints,
            page_exchanges,
            get_exchange,
            frida_preflight,
            device_preflight,
            start_capture,
            get_capture_status,
            stop_capture,
            add_capture_marker
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

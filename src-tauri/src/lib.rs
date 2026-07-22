pub mod app_state;
pub mod capture;
pub mod commands;
pub mod domain;
pub mod provider;
pub mod store;

use std::path::PathBuf;

use app_state::AppState;
use commands::{create_demo_session, frida_preflight, page_events};
use provider::ProviderRuntime;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let sessions_root = app.path().app_data_dir()?.join("sessions");
            std::fs::create_dir_all(&sessions_root)?;
            let source_project =
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sidecars/ios-provider");
            let search_directories = std::env::current_exe()?
                .parent()
                .map(std::path::Path::to_path_buf)
                .into_iter()
                .collect::<Vec<_>>();
            let provider_runtime = ProviderRuntime::discover(&search_directories, source_project)?;
            app.manage(AppState::new(sessions_root, provider_runtime));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_demo_session,
            page_events,
            frida_preflight
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

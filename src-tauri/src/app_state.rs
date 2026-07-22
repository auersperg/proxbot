use std::path::PathBuf;

use tokio::sync::Mutex;

pub struct AppState {
    pub sessions_root: PathBuf,
    pub provider_project: PathBuf,
    pub active_capture: Mutex<bool>,
}

impl AppState {
    pub fn new(sessions_root: PathBuf, provider_project: PathBuf) -> Self {
        Self {
            sessions_root,
            provider_project,
            active_capture: Mutex::new(false),
        }
    }
}

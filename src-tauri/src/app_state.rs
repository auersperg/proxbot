use std::path::PathBuf;

use tokio::sync::Mutex;

use crate::provider::ProviderRuntime;

pub struct AppState {
    pub sessions_root: PathBuf,
    pub provider_runtime: ProviderRuntime,
    pub active_capture: Mutex<bool>,
}

impl AppState {
    pub fn new(sessions_root: PathBuf, provider_runtime: ProviderRuntime) -> Self {
        Self {
            sessions_root,
            provider_runtime,
            active_capture: Mutex::new(false),
        }
    }
}

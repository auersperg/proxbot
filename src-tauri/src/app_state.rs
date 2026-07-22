use std::{path::PathBuf, sync::Arc};

use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{provider::ProviderRuntime, store::EventIndex};

pub struct AppState {
    pub sessions_root: PathBuf,
    pub provider_runtime: ProviderRuntime,
    pub active_capture: Mutex<bool>,
    pub session_index: Mutex<Option<(Uuid, Arc<EventIndex>)>>,
}

impl AppState {
    pub fn new(sessions_root: PathBuf, provider_runtime: ProviderRuntime) -> Self {
        Self {
            sessions_root,
            provider_runtime,
            active_capture: Mutex::new(false),
            session_index: Mutex::new(None),
        }
    }
}

use std::{path::PathBuf, sync::Arc};

use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{capture::LiveCaptureService, provider::ProviderRuntime, store::EventIndex};

pub struct AppState {
    pub sessions_root: PathBuf,
    pub provider_runtime: ProviderRuntime,
    pub proxy_runtime: ProviderRuntime,
    pub live_capture: Arc<LiveCaptureService>,
    pub session_index: Mutex<Option<(Uuid, Arc<EventIndex>)>>,
}

impl AppState {
    pub fn new(
        sessions_root: PathBuf,
        provider_runtime: ProviderRuntime,
        proxy_runtime: ProviderRuntime,
    ) -> Self {
        let live_capture = Arc::new(LiveCaptureService::new(
            sessions_root.clone(),
            provider_runtime.clone(),
            proxy_runtime.clone(),
        ));
        Self {
            sessions_root,
            provider_runtime,
            proxy_runtime,
            live_capture,
            session_index: Mutex::new(None),
        }
    }
}

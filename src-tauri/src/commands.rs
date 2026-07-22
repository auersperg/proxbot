use std::{path::Path, process::Stdio};

use serde::Serialize;
use serde_json::Value;
use tauri::State;
use tokio::process::Command;
use uuid::Uuid;

use crate::{
    app_state::AppState,
    capture::run_fake_capture,
    domain::{EvidenceClass, ParseStatus, ProviderEvent, RawArtifactRef},
    store::EventIndex,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSummaryDto {
    pub session_id: Uuid,
    pub session_dir: String,
    pub event_count: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawArtifactRefDto {
    pub relative_path: String,
    pub offset: u64,
    pub length: u64,
    pub sha256: Option<String>,
}

impl From<RawArtifactRef> for RawArtifactRefDto {
    fn from(value: RawArtifactRef) -> Self {
        Self {
            relative_path: value.relative_path,
            offset: value.offset,
            length: value.length,
            sha256: value.sha256,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEventDto {
    pub schema_version: u16,
    pub provider_id: String,
    pub provider_version: String,
    pub session_id: Uuid,
    pub sequence: u64,
    pub source_time_ns: i64,
    pub host_time_ns: i64,
    pub monotonic_time_ns: Option<i64>,
    pub device_id: Option<String>,
    pub process_id: Option<u32>,
    pub process_name: Option<String>,
    pub evidence: EvidenceClass,
    pub kind: String,
    pub payload: Value,
    pub raw_ref: Option<RawArtifactRefDto>,
    pub parse_status: ParseStatus,
}

impl From<ProviderEvent> for ProviderEventDto {
    fn from(value: ProviderEvent) -> Self {
        Self {
            schema_version: value.schema_version,
            provider_id: value.provider_id,
            provider_version: value.provider_version,
            session_id: value.session_id,
            sequence: value.sequence,
            source_time_ns: value.source_time_ns,
            host_time_ns: value.host_time_ns,
            monotonic_time_ns: value.monotonic_time_ns,
            device_id: value.device_id,
            process_id: value.process_id,
            process_name: value.process_name,
            evidence: value.evidence,
            kind: value.kind,
            payload: value.payload,
            raw_ref: value.raw_ref.map(Into::into),
            parse_status: value.parse_status,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPageDto {
    pub events: Vec<ProviderEventDto>,
    pub total: u64,
}

pub fn validate_capture_count(count: u64) -> anyhow::Result<u64> {
    anyhow::ensure!(
        (1..=10_000).contains(&count),
        "count must be between 1 and 10000"
    );
    Ok(count)
}

pub fn validate_page_request(limit: u64) -> anyhow::Result<u64> {
    anyhow::ensure!(limit > 0, "page limit must be positive");
    Ok(limit.min(500))
}

pub async fn run_frida_preflight(provider_project: &Path) -> anyhow::Result<Value> {
    let uv = [
        std::env::var("TRACELAB_UV").ok(),
        Some("/opt/homebrew/bin/uv".to_owned()),
        Some("/usr/local/bin/uv".to_owned()),
        Some("uv".to_owned()),
    ]
    .into_iter()
    .flatten()
    .find(|candidate| candidate == "uv" || Path::new(candidate).exists())
    .expect("uv fallback is always present");
    let output = Command::new(uv)
        .args(["run", "--project"])
        .arg(provider_project)
        .args(["tracelab-ios-provider", "frida-preflight"])
        .stdin(Stdio::null())
        .output()
        .await?;
    anyhow::ensure!(
        output.status.success(),
        "Frida preflight failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}

#[tauri::command]
pub async fn create_demo_session(
    count: u64,
    state: State<'_, AppState>,
) -> Result<CaptureSummaryDto, String> {
    let count = validate_capture_count(count).map_err(|error| error.to_string())?;
    {
        let mut active = state.active_capture.lock().await;
        if *active {
            return Err("another capture is already active".into());
        }
        *active = true;
    }
    let result = run_fake_capture(&state.sessions_root, &state.provider_project, count).await;
    *state.active_capture.lock().await = false;
    let summary = result.map_err(|error| error.to_string())?;
    Ok(CaptureSummaryDto {
        session_id: summary.session_id,
        session_dir: summary.session_dir.display().to_string(),
        event_count: summary.event_count,
    })
}

#[tauri::command]
pub async fn page_events(
    session_id: String,
    offset: u64,
    limit: u64,
    state: State<'_, AppState>,
) -> Result<EventPageDto, String> {
    let session_id = Uuid::parse_str(&session_id).map_err(|error| error.to_string())?;
    let limit = validate_page_request(limit).map_err(|error| error.to_string())?;
    let database = state
        .sessions_root
        .join(session_id.to_string())
        .join("database/session.sqlite");
    let page = EventIndex::open(&database)
        .and_then(|index| index.page(session_id, offset, limit))
        .map_err(|error| error.to_string())?;
    Ok(EventPageDto {
        events: page.events.into_iter().map(Into::into).collect(),
        total: page.total,
    })
}

#[tauri::command]
pub async fn frida_preflight(state: State<'_, AppState>) -> Result<Value, String> {
    run_frida_preflight(&state.provider_project)
        .await
        .map_err(|error| error.to_string())
}

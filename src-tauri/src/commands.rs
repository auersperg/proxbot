use std::{path::Path, process::Stdio, sync::Arc};

use serde::Serialize;
use serde_json::Value;
use tauri::State;
use tokio::process::Command;
use uuid::Uuid;

use crate::{
    app_state::AppState,
    capture::run_fake_capture_with_runtime,
    domain::{EvidenceClass, RawArtifactRef},
    provider::ProviderRuntime,
    store::{EndpointFilter, EndpointKind, EndpointSummary, EventIndex, ExchangeRow, RawView},
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
pub struct EndpointSummaryDto {
    pub kind: EndpointKind,
    pub value: String,
    pub count: u64,
}

impl From<EndpointSummary> for EndpointSummaryDto {
    fn from(value: EndpointSummary) -> Self {
        Self {
            kind: value.kind,
            value: value.value,
            count: value.count,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawViewDto {
    pub content: String,
    pub media_type: String,
    pub evidence: EvidenceClass,
    pub reconstructed: Option<bool>,
    pub truncated: Option<bool>,
    pub masked: Option<bool>,
    pub artifact: Option<RawArtifactRefDto>,
}

impl From<RawView> for RawViewDto {
    fn from(value: RawView) -> Self {
        Self {
            content: value.content,
            media_type: value.media_type,
            evidence: value.evidence,
            reconstructed: value.reconstructed,
            truncated: value.truncated,
            masked: value.masked,
            artifact: value.artifact.map(Into::into),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeRowDto {
    pub request_id: String,
    pub request_sequence: Option<u64>,
    pub response_sequence: Option<u64>,
    pub started_ns: String,
    pub method: Option<String>,
    pub scheme: Option<String>,
    pub host: Option<String>,
    pub ip: Option<String>,
    pub path: Option<String>,
    pub status: Option<u16>,
    pub protocol: Option<String>,
    pub process_name: Option<String>,
    pub duration_ms: Option<u64>,
    pub request_bytes: Option<u64>,
    pub response_bytes: Option<u64>,
    pub tls: Option<String>,
    pub evidence: EvidenceClass,
    pub warning: Option<String>,
    pub request_raw: Option<RawViewDto>,
    pub response_raw: Option<RawViewDto>,
}

impl From<ExchangeRow> for ExchangeRowDto {
    fn from(value: ExchangeRow) -> Self {
        Self {
            request_id: value.request_id,
            request_sequence: value.request_sequence,
            response_sequence: value.response_sequence,
            started_ns: value.started_ns.to_string(),
            method: value.method,
            scheme: value.scheme,
            host: value.host,
            ip: value.ip,
            path: value.path,
            status: value.status,
            protocol: value.protocol,
            process_name: value.process_name,
            duration_ms: value.duration_ms,
            request_bytes: value.request_bytes,
            response_bytes: value.response_bytes,
            tls: value.tls,
            evidence: value.evidence,
            warning: value.warning,
            request_raw: value.request_raw.map(Into::into),
            response_raw: value.response_raw.map(Into::into),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangePageDto {
    pub exchanges: Vec<ExchangeRowDto>,
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

pub fn validate_endpoint_limit(limit: u64) -> anyhow::Result<u64> {
    anyhow::ensure!(limit > 0, "endpoint limit must be positive");
    Ok(limit.min(2_000))
}

pub fn validate_request_id(request_id: &str) -> anyhow::Result<&str> {
    anyhow::ensure!(
        !request_id.trim().is_empty(),
        "request ID must not be empty"
    );
    anyhow::ensure!(
        request_id.len() <= 512,
        "request ID must not exceed 512 bytes"
    );
    Ok(request_id)
}

pub fn validate_query(query: &str) -> anyhow::Result<&str> {
    anyhow::ensure!(query.len() <= 1_024, "query must not exceed 1024 bytes");
    Ok(query)
}

pub fn validate_endpoint_value(value: &str) -> anyhow::Result<&str> {
    anyhow::ensure!(!value.trim().is_empty(), "endpoint value must not be empty");
    anyhow::ensure!(
        value.len() <= 512,
        "endpoint value must not exceed 512 bytes"
    );
    Ok(value)
}

fn parse_endpoint(
    kind: Option<String>,
    value: Option<String>,
) -> Result<Option<EndpointFilter>, String> {
    match (kind, value) {
        (None, None) => Ok(None),
        (Some(kind), Some(value)) => {
            validate_endpoint_value(&value).map_err(|error| error.to_string())?;
            let kind = match kind.as_str() {
                "domain" => EndpointKind::Domain,
                "ip" => EndpointKind::Ip,
                _ => return Err("endpoint kind must be domain or ip".into()),
            };
            Ok(Some(EndpointFilter { kind, value }))
        }
        _ => Err("endpoint kind and value must be supplied together".into()),
    }
}

fn session_database(state: &AppState, session_id: Uuid) -> std::path::PathBuf {
    state
        .sessions_root
        .join(session_id.to_string())
        .join("database/session.sqlite")
}

async fn cached_session_index(
    state: &AppState,
    session_id: Uuid,
) -> anyhow::Result<Arc<EventIndex>> {
    let mut cached = state.session_index.lock().await;
    if let Some((cached_id, index)) = cached.as_ref()
        && *cached_id == session_id
    {
        return Ok(Arc::clone(index));
    }
    let database = session_database(state, session_id);
    let index = tokio::task::spawn_blocking(move || EventIndex::open(&database)).await??;
    let index = Arc::new(index);
    *cached = Some((session_id, Arc::clone(&index)));
    Ok(index)
}

pub async fn run_frida_preflight(provider_project: &Path) -> anyhow::Result<Value> {
    let runtime = ProviderRuntime::discover(&[], provider_project.to_path_buf())?;
    run_frida_preflight_with_runtime(&runtime).await
}

pub async fn run_frida_preflight_with_runtime(runtime: &ProviderRuntime) -> anyhow::Result<Value> {
    let invocation = runtime.invocation("device-preflight", &[]);
    let output = Command::new(invocation.program)
        .args(invocation.arguments)
        .stdin(Stdio::null())
        .output()
        .await?;
    anyhow::ensure!(
        output.status.success(),
        "iPhone preflight failed: {}",
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
    *state.session_index.lock().await = None;
    let result =
        run_fake_capture_with_runtime(&state.sessions_root, &state.provider_runtime, count).await;
    *state.active_capture.lock().await = false;
    let summary = result.map_err(|error| error.to_string())?;
    Ok(CaptureSummaryDto {
        session_id: summary.session_id,
        session_dir: summary.session_dir.display().to_string(),
        event_count: summary.event_count,
    })
}

#[tauri::command]
pub async fn list_endpoints(
    session_id: String,
    query: String,
    limit: u64,
    state: State<'_, AppState>,
) -> Result<Vec<EndpointSummaryDto>, String> {
    let session_id = Uuid::parse_str(&session_id).map_err(|error| error.to_string())?;
    let limit = validate_endpoint_limit(limit).map_err(|error| error.to_string())?;
    validate_query(&query).map_err(|error| error.to_string())?;
    let index = cached_session_index(&state, session_id)
        .await
        .map_err(|error| error.to_string())?;
    tokio::task::spawn_blocking(move || index.list_endpoints(session_id, &query, limit))
        .await
        .map_err(|error| error.to_string())?
        .map(|items| items.into_iter().map(Into::into).collect())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn page_exchanges(
    session_id: String,
    query: String,
    endpoint_kind: Option<String>,
    endpoint_value: Option<String>,
    offset: u64,
    limit: u64,
    state: State<'_, AppState>,
) -> Result<ExchangePageDto, String> {
    let session_id = Uuid::parse_str(&session_id).map_err(|error| error.to_string())?;
    let limit = validate_page_request(limit).map_err(|error| error.to_string())?;
    validate_query(&query).map_err(|error| error.to_string())?;
    let endpoint = parse_endpoint(endpoint_kind, endpoint_value)?;
    let index = cached_session_index(&state, session_id)
        .await
        .map_err(|error| error.to_string())?;
    let page = tokio::task::spawn_blocking(move || {
        index.page_exchanges(session_id, &query, endpoint.as_ref(), offset, limit)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?;
    Ok(ExchangePageDto {
        exchanges: page.exchanges.into_iter().map(Into::into).collect(),
        total: page.total,
    })
}

#[tauri::command]
pub async fn get_exchange(
    session_id: String,
    request_id: String,
    state: State<'_, AppState>,
) -> Result<Option<ExchangeRowDto>, String> {
    let session_id = Uuid::parse_str(&session_id).map_err(|error| error.to_string())?;
    validate_request_id(&request_id).map_err(|error| error.to_string())?;
    let index = cached_session_index(&state, session_id)
        .await
        .map_err(|error| error.to_string())?;
    tokio::task::spawn_blocking(move || index.get_exchange(session_id, &request_id))
        .await
        .map_err(|error| error.to_string())?
        .map(|exchange| exchange.map(Into::into))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn frida_preflight(state: State<'_, AppState>) -> Result<Value, String> {
    run_frida_preflight_with_runtime(&state.provider_runtime)
        .await
        .map_err(|error| error.to_string())
}

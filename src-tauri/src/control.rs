use std::{
    os::unix::fs::FileTypeExt,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
};
use uuid::Uuid;

use crate::capture::LiveCaptureService;

const PROTOCOL_VERSION: u16 = 1;
const MAX_REQUEST_BYTES: u64 = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ControlRequest {
    version: u16,
    id: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct ControlResponse<'a> {
    version: u16,
    id: &'a str,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ControlError>,
}

#[derive(Debug, Serialize)]
struct ControlError {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeviceParams {
    #[serde(default)]
    device_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartParams {
    profile: String,
    #[serde(default)]
    device_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MarkerParams {
    #[serde(default)]
    label: Option<String>,
}

pub async fn serve_local_control(
    socket_path: PathBuf,
    service: Arc<LiveCaptureService>,
) -> anyhow::Result<()> {
    prepare_socket_path(&socket_path)?;
    let listener = UnixListener::bind(&socket_path)?;
    set_socket_owner_only(&socket_path)?;
    let _cleanup = SocketCleanup(socket_path);
    loop {
        let (stream, _) = listener.accept().await?;
        let service = Arc::clone(&service);
        tokio::spawn(async move {
            let _ = handle_connection(stream, service).await;
        });
    }
}

async fn handle_connection(
    stream: UnixStream,
    service: Arc<LiveCaptureService>,
) -> anyhow::Result<()> {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader).take(MAX_REQUEST_BYTES + 1);
    let mut bytes = Vec::new();
    let read = reader.read_until(b'\n', &mut bytes).await?;
    if read == 0 {
        return Ok(());
    }
    if read as u64 > MAX_REQUEST_BYTES || !bytes.ends_with(b"\n") {
        write_error(
            &mut writer,
            "",
            "request_too_large",
            "request must be one JSON line of at most 65536 bytes",
        )
        .await?;
        return Ok(());
    }
    let request: ControlRequest = match serde_json::from_slice(&bytes) {
        Ok(request) => request,
        Err(error) => {
            write_error(&mut writer, "", "invalid_request", &error.to_string()).await?;
            return Ok(());
        }
    };
    if request.version != PROTOCOL_VERSION {
        write_error(
            &mut writer,
            &request.id,
            "unsupported_version",
            "control protocol version must be 1",
        )
        .await?;
        return Ok(());
    }
    if Uuid::parse_str(&request.id).is_err() {
        write_error(
            &mut writer,
            &request.id,
            "invalid_request",
            "id must be a UUID",
        )
        .await?;
        return Ok(());
    }
    let result = dispatch(&service, &request.method, request.params).await;
    let response = match result {
        Ok(result) => ControlResponse {
            version: PROTOCOL_VERSION,
            id: &request.id,
            ok: true,
            result: Some(result),
            error: None,
        },
        Err(error) => ControlResponse {
            version: PROTOCOL_VERSION,
            id: &request.id,
            ok: false,
            result: None,
            error: Some(error),
        },
    };
    write_response(&mut writer, &response).await
}

async fn dispatch(
    service: &LiveCaptureService,
    method: &str,
    params: Value,
) -> Result<Value, ControlError> {
    let operation = async {
        match method {
            "device_preflight" => {
                let params: DeviceParams = decode_params(params)?;
                Ok(serde_json::to_value(
                    service
                        .device_preflight(params.device_id.as_deref())
                        .await?,
                )?)
            }
            "start_capture" => {
                let params: StartParams = decode_params(params)?;
                Ok(serde_json::to_value(
                    service
                        .start_capture(&params.profile, params.device_id)
                        .await?,
                )?)
            }
            "get_capture_status" => Ok(serde_json::to_value(service.status().await)?),
            "stop_capture" => Ok(serde_json::to_value(service.stop_capture().await?)?),
            "add_capture_marker" => {
                let params: MarkerParams = decode_params(params)?;
                Ok(serde_json::to_value(
                    service.add_marker(params.label).await?,
                )?)
            }
            _ => anyhow::bail!("unknown control method: {method}"),
        }
    }
    .await;
    operation.map_err(|error: anyhow::Error| ControlError {
        code: if error.to_string().starts_with("unknown control method") {
            "method_not_found"
        } else {
            "operation_failed"
        },
        message: error.to_string(),
        details: None,
    })
}

fn decode_params<T: for<'de> Deserialize<'de>>(params: Value) -> anyhow::Result<T> {
    Ok(serde_json::from_value(if params.is_null() {
        json!({})
    } else {
        params
    })?)
}

async fn write_error<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    id: &str,
    code: &'static str,
    message: &str,
) -> anyhow::Result<()> {
    write_response(
        writer,
        &ControlResponse {
            version: PROTOCOL_VERSION,
            id,
            ok: false,
            result: None,
            error: Some(ControlError {
                code,
                message: message.to_owned(),
                details: None,
            }),
        },
    )
    .await
}

async fn write_response<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    response: &ControlResponse<'_>,
) -> anyhow::Result<()> {
    let mut payload = serde_json::to_vec(response)?;
    payload.push(b'\n');
    writer.write_all(&payload).await?;
    writer.shutdown().await?;
    Ok(())
}

fn prepare_socket_path(path: &Path) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            anyhow::ensure!(
                metadata.file_type().is_socket(),
                "refusing non-socket control path"
            );
            std::fs::remove_file(path)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

#[cfg(unix)]
fn set_socket_owner_only(path: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

struct SocketCleanup(PathBuf);

impl Drop for SocketCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

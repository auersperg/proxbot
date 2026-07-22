use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use proxbot_lib::{
    capture::LiveCaptureService, control::serve_local_control, provider::ProviderRuntime,
};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
};
use uuid::Uuid;

fn socket_path() -> PathBuf {
    std::env::temp_dir().join(format!("proxbot-control-{}.sock", Uuid::new_v4().simple()))
}

async fn wait_for_socket(path: &Path) {
    for _ in 0..100 {
        if path.exists() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("control socket was not created");
}

async fn request(path: &Path, request: Value) -> Value {
    let mut stream = UnixStream::connect(path).await.unwrap();
    let mut payload = serde_json::to_vec(&request).unwrap();
    payload.push(b'\n');
    stream.write_all(&payload).await.unwrap();
    let mut response = String::new();
    BufReader::new(stream)
        .read_line(&mut response)
        .await
        .unwrap();
    serde_json::from_str(&response).unwrap()
}

#[tokio::test]
async fn owner_only_bridge_serves_bounded_versioned_status() {
    let root = tempfile::tempdir().unwrap();
    let runtime = ProviderRuntime::from_executable(PathBuf::from("/usr/bin/true")).unwrap();
    let service = Arc::new(LiveCaptureService::new(
        root.path().join("sessions"),
        runtime,
    ));
    let path = socket_path();
    let task = tokio::spawn(serve_local_control(path.clone(), service));
    wait_for_socket(&path).await;
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );

    let id = Uuid::new_v4().to_string();
    let response = request(
        &path,
        json!({
            "version": 1,
            "id": id,
            "method": "get_capture_status",
            "params": {}
        }),
    )
    .await;
    assert_eq!(response["version"], 1);
    assert_eq!(response["id"], id);
    assert_eq!(response["ok"], true);
    assert_eq!(response["result"]["status"], "idle");

    let invalid = request(
        &path,
        json!({
            "version": 2,
            "id": Uuid::new_v4(),
            "method": "get_capture_status",
            "params": {}
        }),
    )
    .await;
    assert_eq!(invalid["ok"], false);
    assert_eq!(invalid["error"]["code"], "unsupported_version");

    task.abort();
    let _ = task.await;
    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn bridge_refuses_a_symlink_control_path() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("target");
    std::fs::write(&target, b"preserve").unwrap();
    let path = root.path().join("control.sock");
    std::os::unix::fs::symlink(&target, &path).unwrap();
    let runtime = ProviderRuntime::from_executable(PathBuf::from("/usr/bin/true")).unwrap();
    let service = Arc::new(LiveCaptureService::new(
        root.path().join("sessions"),
        runtime,
    ));

    let error = serve_local_control(path, service).await.unwrap_err();
    assert!(error.to_string().contains("refusing non-socket"));
    assert_eq!(std::fs::read(&target).unwrap(), b"preserve");
}

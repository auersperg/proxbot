use std::path::PathBuf;

use proxbot_lib::{
    capture::{CaptureSnapshot, CaptureStatus, DevicePreflight, LiveCaptureService},
    provider::ProviderRuntime,
};

#[test]
fn typed_device_preflight_deserializes_provider_contract() {
    let device: DevicePreflight = serde_json::from_value(serde_json::json!({
        "available": true,
        "id": "USB-UDID",
        "name": "iPhone",
        "type": "usb",
        "connectionType": "usb",
        "paired": true,
        "trusted": true,
        "productType": "iPhone16,1",
        "productVersion": "27.0",
        "buildVersion": "24A000",
        "developerMode": true,
        "error": null
    }))
    .unwrap();
    assert!(device.available);
    assert_eq!(device.id.as_deref(), Some("USB-UDID"));
    assert_eq!(device.paired, Some(true));
    assert_eq!(device.trusted, Some(true));
}

#[tokio::test]
async fn idle_snapshot_matches_reactive_frontend_contract() {
    let runtime = ProviderRuntime::from_executable(PathBuf::from("/usr/bin/true")).unwrap();
    let service = LiveCaptureService::new(std::env::temp_dir(), runtime);
    let snapshot = service.status().await;
    assert_eq!(snapshot, CaptureSnapshot::default());
    assert_eq!(snapshot.status, CaptureStatus::Idle);
    let json = serde_json::to_value(snapshot).unwrap();
    assert_eq!(json["status"], "idle");
    assert!(json.get("sessionId").is_some());
    assert!(json.get("sessionDir").is_some());
    assert!(json.get("profile").is_some());
    assert!(json["metrics"].get("lastEventAgeMs").is_some());
    assert!(json.get("sources").is_some());
    assert!(json["metrics"].get("lastEventAtMs").is_none());
}

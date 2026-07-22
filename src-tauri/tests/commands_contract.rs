use std::{fs, os::unix::fs::PermissionsExt};

use proxbot_lib::{
    commands::{
        ExchangeRowDto, run_frida_preflight_with_runtime, validate_capture_count,
        validate_endpoint_limit, validate_endpoint_value, validate_page_request, validate_query,
        validate_request_id,
    },
    domain::EvidenceClass,
    provider::ProviderRuntime,
    store::{ExchangeRow, RawView},
};

#[test]
fn command_bounds_reject_invalid_capture_and_page_sizes() {
    assert!(validate_capture_count(0).is_err());
    assert!(validate_capture_count(10_001).is_err());
    assert_eq!(validate_capture_count(30).unwrap(), 30);
    assert!(validate_page_request(0).is_err());
    assert_eq!(validate_page_request(900).unwrap(), 500);
    assert!(validate_request_id("").is_err());
    assert!(validate_request_id("   ").is_err());
    assert!(validate_request_id(&"x".repeat(513)).is_err());
    assert_eq!(validate_request_id("request-1").unwrap(), "request-1");
    assert!(validate_query(&"x".repeat(1_025)).is_err());
    assert_eq!(validate_query("host:fixture").unwrap(), "host:fixture");
    assert!(validate_endpoint_value("").is_err());
    assert!(validate_endpoint_value(&"x".repeat(513)).is_err());
}

#[tokio::test]
async fn frida_preflight_returns_one_structured_result() {
    let root = tempfile::tempdir().unwrap();
    let provider = root.path().join("provider");
    fs::write(
        &provider,
        "#!/bin/sh\nprintf '%s\\n' '{\"available\":false,\"device\":null}'\n",
    )
    .unwrap();
    fs::set_permissions(&provider, fs::Permissions::from_mode(0o700)).unwrap();
    let runtime = ProviderRuntime::from_executable(provider).unwrap();
    let result = run_frida_preflight_with_runtime(&runtime).await.unwrap();
    assert!(
        result
            .get("available")
            .and_then(|value| value.as_bool())
            .is_some()
    );
}

#[test]
fn exchange_command_contract_is_bounded_and_preserves_absent_response() {
    assert_eq!(validate_endpoint_limit(9_000).unwrap(), 2_000);
    assert!(validate_endpoint_limit(0).is_err());
    let dto = ExchangeRowDto::from(ExchangeRow {
        request_id: "request-1".into(),
        request_sequence: Some(1),
        response_sequence: None,
        started_ns: 1_800_000_000_000_000_001,
        method: Some("POST".into()),
        scheme: Some("https".into()),
        host: Some("auth.privy.io".into()),
        ip: Some("192.0.2.10".into()),
        path: Some("/rpc".into()),
        status: None,
        protocol: Some("HTTP/2".into()),
        process_name: Some("FixtureApp".into()),
        duration_ms: None,
        request_bytes: Some(42),
        response_bytes: None,
        tls: Some("decrypted".into()),
        evidence: EvidenceClass::Observed,
        warning: Some("response_missing".into()),
        request_raw: Some(RawView {
            content: "POST /rpc HTTP/2\r\n\r\n".into(),
            media_type: "application/http".into(),
            evidence: EvidenceClass::Observed,
            reconstructed: Some(true),
            truncated: Some(false),
            masked: Some(false),
            artifact: None,
        }),
        response_raw: None,
    });
    let value = serde_json::to_value(dto).unwrap();
    assert_eq!(value["startedNs"], "1800000000000000001");
    assert!(value["responseRaw"].is_null());
    assert_eq!(value["requestRaw"]["reconstructed"], true);
}

#[test]
fn exchange_page_rows_serialize_without_raw_detail() {
    let dto = ExchangeRowDto::from(ExchangeRow {
        request_id: "request-1".into(),
        request_sequence: Some(1),
        response_sequence: Some(2),
        started_ns: 1_800_000_000_000_000_001,
        method: Some("GET".into()),
        scheme: Some("https".into()),
        host: Some("api.example.test".into()),
        ip: Some("192.0.2.10".into()),
        path: Some("/".into()),
        status: Some(200),
        protocol: Some("HTTP/2".into()),
        process_name: Some("FixtureApp".into()),
        duration_ms: Some(20),
        request_bytes: Some(30),
        response_bytes: Some(40),
        tls: Some("decrypted".into()),
        evidence: EvidenceClass::Observed,
        warning: None,
        request_raw: None,
        response_raw: None,
    });
    let value = serde_json::to_value(dto).unwrap();
    assert!(value["requestRaw"].is_null());
    assert!(value["responseRaw"].is_null());
}

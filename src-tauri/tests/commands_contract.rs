use std::path::Path;

use proxbot_lib::{
    commands::{
        ExchangeRowDto, ProviderEventDto, run_frida_preflight, validate_capture_count,
        validate_endpoint_limit, validate_page_request, validate_request_id,
    },
    domain::{EvidenceClass, ParseStatus, ProviderEvent},
    store::{ExchangeRow, RawView},
};
use serde_json::json;
use uuid::Uuid;

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
}

#[tokio::test]
async fn frida_preflight_returns_one_structured_result() {
    let project = Path::new(env!("CARGO_MANIFEST_DIR")).join("../sidecars/ios-provider");
    let result = run_frida_preflight(&project).await.unwrap();
    assert!(
        result
            .get("available")
            .and_then(|value| value.as_bool())
            .is_some()
    );
}

#[test]
fn command_dto_preserves_nanoseconds_as_decimal_strings() {
    let dto = ProviderEventDto::from(ProviderEvent {
        schema_version: 1,
        provider_id: "fake".into(),
        provider_version: "1".into(),
        session_id: Uuid::nil(),
        sequence: 1,
        source_time_ns: 1_800_000_000_000_000_001,
        host_time_ns: 1_800_000_000_000_000_002,
        monotonic_time_ns: Some(1_800_000_000_000_000_003),
        device_id: None,
        process_id: None,
        process_name: None,
        evidence: EvidenceClass::Observed,
        kind: "fixture".into(),
        payload: json!({}),
        raw_ref: None,
        parse_status: ParseStatus::Parsed,
    });
    let value = serde_json::to_value(dto).unwrap();
    assert_eq!(value["sourceTimeNs"], "1800000000000000001");
    assert_eq!(value["hostTimeNs"], "1800000000000000002");
    assert_eq!(value["monotonicTimeNs"], "1800000000000000003");
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
            reconstructed: true,
            truncated: false,
            masked: false,
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

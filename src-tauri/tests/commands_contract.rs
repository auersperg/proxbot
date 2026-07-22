use std::path::Path;

use serde_json::json;
use trace_lab_lib::{
    commands::{
        ProviderEventDto, run_frida_preflight, validate_capture_count, validate_page_request,
    },
    domain::{EvidenceClass, ParseStatus, ProviderEvent},
};
use uuid::Uuid;

#[test]
fn command_bounds_reject_invalid_capture_and_page_sizes() {
    assert!(validate_capture_count(0).is_err());
    assert!(validate_capture_count(10_001).is_err());
    assert_eq!(validate_capture_count(30).unwrap(), 30);
    assert!(validate_page_request(0).is_err());
    assert_eq!(validate_page_request(900).unwrap(), 500);
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

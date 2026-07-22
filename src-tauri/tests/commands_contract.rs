use std::path::Path;

use trace_lab_lib::commands::{run_frida_preflight, validate_capture_count, validate_page_request};

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

use proxbot_lib::{
    domain::{EvidenceClass, ParseStatus, ProviderEvent},
    store::{EndpointFilter, EndpointKind, EventIndex},
};
use serde_json::json;
use tempfile::tempdir;
use uuid::Uuid;

fn event(session_id: Uuid, sequence: u64, kind: &str, payload: serde_json::Value) -> ProviderEvent {
    ProviderEvent {
        schema_version: 1,
        provider_id: "fake".into(),
        provider_version: "1".into(),
        session_id,
        sequence,
        source_time_ns: 1_784_730_000_000_000_000 + sequence as i64,
        host_time_ns: 1_784_730_000_100_000_000 + sequence as i64,
        monotonic_time_ns: Some(sequence as i64),
        device_id: Some("fixture-device".into()),
        process_id: Some(42),
        process_name: Some("FixtureApp".into()),
        evidence: EvidenceClass::Observed,
        kind: kind.into(),
        payload,
        raw_ref: None,
        parse_status: ParseStatus::Parsed,
    }
}

#[test]
fn materializes_paired_raw_exchange_and_endpoint_counts() {
    let dir = tempdir().unwrap();
    let index = EventIndex::open(&dir.path().join("session.sqlite")).unwrap();
    let session = Uuid::new_v4();
    index
        .insert(&event(
            session,
            1,
            "network.request",
            json!({
                "request_id": "request-1", "scheme": "https", "host": "auth.privy.io",
                "ip": "192.0.2.10", "method": "POST", "path": "/api/v1/wallets/rpc",
                "protocol": "HTTP/2", "tls": "decrypted", "request_bytes": 128,
                "raw": "POST /api/v1/wallets/rpc HTTP/2\r\nHost: auth.privy.io\r\n\r\n{}",
                "media_type": "application/http", "reconstructed": true,
                "truncated": false, "masked": false
            }),
        ))
        .unwrap();
    index
        .insert(&event(
            session,
            2,
            "network.response",
            json!({
                "request_id": "request-1", "status": 200, "protocol": "HTTP/2",
                "duration_ms": 41, "response_bytes": 64,
                "raw": "HTTP/2 200 OK\r\nContent-Length: 2\r\n\r\n{}",
                "media_type": "application/http", "reconstructed": true,
                "truncated": false, "masked": false
            }),
        ))
        .unwrap();

    let page = index.page_exchanges(session, "", None, 0, 200).unwrap();
    assert_eq!(page.total, 1);
    let exchange = &page.exchanges[0];
    assert_eq!(exchange.request_id, "request-1");
    assert_eq!(exchange.status, Some(200));
    assert_eq!(exchange.warning, None);
    assert!(exchange.request_raw.content.contains("Host: auth.privy.io"));
    assert!(
        exchange
            .response_raw
            .as_ref()
            .unwrap()
            .content
            .contains("200 OK")
    );
    assert!(exchange.request_raw.reconstructed);

    let endpoints = index.list_endpoints(session, "", 2000).unwrap();
    assert!(
        endpoints
            .iter()
            .any(|item| item.kind == EndpointKind::Domain
                && item.value == "auth.privy.io"
                && item.count == 1)
    );
    assert!(endpoints.iter().any(|item| item.kind == EndpointKind::Ip
        && item.value == "192.0.2.10"
        && item.count == 1));
}

#[test]
fn filters_exchanges_and_marks_missing_response() {
    let dir = tempdir().unwrap();
    let index = EventIndex::open(&dir.path().join("session.sqlite")).unwrap();
    let session = Uuid::new_v4();
    index.insert(&event(session, 1, "network.request", json!({
        "request_id": "request-1", "scheme": "https", "host": "api.example.test",
        "ip": "198.51.100.8", "method": "GET", "path": "/health",
        "protocol": "HTTP/1.1", "request_bytes": 42, "raw": "GET /health HTTP/1.1\r\n\r\n",
        "media_type": "application/http", "reconstructed": true, "truncated": false, "masked": false
    }))).unwrap();

    let filter = EndpointFilter {
        kind: EndpointKind::Domain,
        value: "api.example.test".into(),
    };
    let page = index
        .page_exchanges(session, "health", Some(&filter), 0, 999)
        .unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.exchanges.len(), 1);
    assert_eq!(
        page.exchanges[0].warning.as_deref(),
        Some("response_missing")
    );
    assert!(page.exchanges[0].response_raw.is_none());
}

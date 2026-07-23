use proxbot_lib::{
    domain::{EvidenceClass, ParseStatus, ProviderEvent, RawArtifactRef},
    store::{CaptureLayer, EndpointFilter, EndpointKind, EventIndex, PlaintextState},
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
    assert!(exchange.request_raw.is_none());
    assert!(exchange.response_raw.is_none());

    let detail = index.get_exchange(session, "request-1").unwrap().unwrap();
    assert_eq!(
        detail.request_raw.as_ref().unwrap().content,
        "POST /api/v1/wallets/rpc HTTP/2\r\nHost: auth.privy.io\r\n\r\n{}"
    );
    assert_eq!(
        detail.response_raw.as_ref().unwrap().content,
        "HTTP/2 200 OK\r\nContent-Length: 2\r\n\r\n{}"
    );
    assert_eq!(
        detail.request_raw.as_ref().unwrap().reconstructed,
        Some(true)
    );

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
fn materializes_live_packet_metadata_as_a_realtime_ip_row() {
    let dir = tempdir().unwrap();
    let index = EventIndex::open(&dir.path().join("session.sqlite")).unwrap();
    let session = Uuid::new_v4();
    index
        .insert(&event(
            session,
            1,
            "network.packet",
            json!({
                "request_id": "packet-000000000001", "method": "OUT",
                "ip": "8.8.8.8", "path": "10.0.0.1:49152 → 8.8.8.8:443",
                "protocol": "TCP", "request_bytes": 54,
                "raw": "OUTBOUND TCP 10.0.0.1:49152 → 8.8.8.8:443 (54 bytes)",
                "media_type": "text/plain; charset=utf-8", "reconstructed": true,
                "truncated": false, "masked": false
            }),
        ))
        .unwrap();

    let page = index.page_exchanges(session, "", None, 0, 200).unwrap();
    assert_eq!(page.total, 1);
    let packet = &page.exchanges[0];
    assert_eq!(packet.method.as_deref(), Some("OUT"));
    assert_eq!(packet.ip.as_deref(), Some("8.8.8.8"));
    assert_eq!(packet.protocol.as_deref(), Some("TCP"));
    assert_eq!(packet.request_bytes, Some(54));
    assert_eq!(packet.warning.as_deref(), Some("packet_metadata"));
    assert_eq!(packet.provider_id, "fake");
    assert_eq!(packet.capture_layer, CaptureLayer::Usb);
    assert_eq!(packet.plaintext_state, PlaintextState::NotObserved);
    assert!(
        index
            .list_endpoints(session, "", 20)
            .unwrap()
            .iter()
            .any(|endpoint| { endpoint.kind == EndpointKind::Ip && endpoint.value == "8.8.8.8" })
    );
}

#[test]
fn materializes_explicit_observed_in_process_plaintext_with_provenance_and_correlation() {
    let dir = tempdir().unwrap();
    let index = EventIndex::open(&dir.path().join("session.sqlite")).unwrap();
    let session = Uuid::new_v4();
    let mut request = event(
        session,
        1,
        "network.request",
        json!({
            "request_id": "process-request-1",
            "correlation_id": "urlsession-task-73",
            "capture_layer": "process",
            "plaintext_state": "observed",
            "host_source": "process.url",
            "scheme": "https",
            "host": "auth.example.test",
            "method": "POST",
            "path": "/rpc",
            "protocol": "HTTP/2",
            "request_bytes": 55,
            "raw": "POST /rpc HTTP/2\r\nHost: auth.example.test\r\n\r\n{}",
            "media_type": "application/http",
            "reconstructed": false,
            "truncated": false,
            "masked": false
        }),
    );
    request.provider_id = "ios-process-observer".into();
    request.process_id = Some(731);
    request.process_name = Some("WalletApp".into());
    index.insert(&request).unwrap();

    let mut response = event(
        session,
        2,
        "network.response",
        json!({
            "request_id": "process-request-1",
            "correlation_id": "urlsession-task-73",
            "capture_layer": "process",
            "plaintext_state": "observed",
            "status": 200,
            "protocol": "HTTP/2",
            "response_bytes": 19,
            "raw": "HTTP/2 200 OK\r\n\r\n{}",
            "media_type": "application/http",
            "reconstructed": false,
            "truncated": false,
            "masked": false
        }),
    );
    response.provider_id = "ios-process-observer".into();
    response.process_id = Some(731);
    response.process_name = Some("WalletApp".into());
    index.insert(&response).unwrap();

    let page = index.page_exchanges(session, "", None, 0, 50).unwrap();
    let row = &page.exchanges[0];
    assert_eq!(row.capture_layer, CaptureLayer::Process);
    assert_eq!(row.plaintext_state, PlaintextState::Observed);
    assert_eq!(row.provider_id, "ios-process-observer");
    assert_eq!(row.correlation_id.as_deref(), Some("urlsession-task-73"));
    assert_eq!(row.host_source.as_deref(), Some("process.url"));
    assert_eq!(row.process_id, Some(731));
    assert_eq!(row.process_name.as_deref(), Some("WalletApp"));
    assert_eq!(row.host.as_deref(), Some("auth.example.test"));

    let correlated = index
        .page_exchanges(session, "urlsession-task-73", None, 0, 50)
        .unwrap();
    assert_eq!(correlated.total, 1);
    let process_filtered = index
        .page_exchanges(session, "WalletApp", None, 0, 50)
        .unwrap();
    assert_eq!(process_filtered.total, 1);

    let detail = index
        .get_exchange(session, "process-request-1")
        .unwrap()
        .unwrap();
    assert!(detail.request_raw.unwrap().content.starts_with("POST /rpc"));
    assert!(
        detail
            .response_raw
            .unwrap()
            .content
            .starts_with("HTTP/2 200")
    );
}

#[test]
fn does_not_promote_an_unobserved_process_claim_to_plaintext_evidence() {
    let dir = tempdir().unwrap();
    let index = EventIndex::open(&dir.path().join("session.sqlite")).unwrap();
    let session = Uuid::new_v4();
    let request = event(
        session,
        1,
        "network.request",
        json!({
            "request_id": "process-request-without-raw",
            "capture_layer": "process",
            "plaintext_state": "observed",
            "host": "api.example.test"
        }),
    );
    index.insert(&request).unwrap();

    let row = index
        .page_exchanges(session, "", None, 0, 50)
        .unwrap()
        .exchanges
        .remove(0);
    assert_eq!(row.capture_layer, CaptureLayer::Process);
    assert_eq!(row.plaintext_state, PlaintextState::Unknown);
}

#[test]
fn derives_proxy_decryption_without_conflating_it_with_process_observation() {
    let dir = tempdir().unwrap();
    let index = EventIndex::open(&dir.path().join("session.sqlite")).unwrap();
    let session = Uuid::new_v4();
    let mut request = event(
        session,
        1,
        "network.request",
        json!({
            "request_id": "proxy-request",
            "host": "api.example.test",
            "tls": "intercepted",
            "raw": "GET / HTTP/1.1\r\nHost: api.example.test\r\n\r\n"
        }),
    );
    request.provider_id = "proxy-mitm".into();
    request.process_id = None;
    request.process_name = None;
    index.insert(&request).unwrap();

    let row = index
        .page_exchanges(session, "", None, 0, 50)
        .unwrap()
        .exchanges
        .remove(0);
    assert_eq!(row.capture_layer, CaptureLayer::Proxy);
    assert_eq!(row.plaintext_state, PlaintextState::Decrypted);
    assert_eq!(row.process_id, None);
}

#[test]
fn preserves_side_specific_evidence_and_unknown_raw_metadata() {
    let dir = tempdir().unwrap();
    let index = EventIndex::open(&dir.path().join("session.sqlite")).unwrap();
    let session = Uuid::new_v4();
    index
        .insert(&event(
            session,
            1,
            "network.request",
            json!({
                "request_id": "request-1", "raw": "GET / HTTP/1.1\r\n\r\n",
                "reconstructed": false, "truncated": false, "masked": false
            }),
        ))
        .unwrap();
    let mut response = event(
        session,
        2,
        "network.response",
        json!({
            "request_id": "request-1", "status": 200,
            "raw": "HTTP/1.1 200 OK\r\n\r\n", "masked": "not-a-boolean"
        }),
    );
    response.evidence = EvidenceClass::Inferred;
    index.insert(&response).unwrap();

    let detail = index.get_exchange(session, "request-1").unwrap().unwrap();
    let request = detail.request_raw.unwrap();
    let response = detail.response_raw.unwrap();
    assert_eq!(detail.evidence, EvidenceClass::Inferred);
    assert_eq!(request.evidence, EvidenceClass::Observed);
    assert_eq!(response.evidence, EvidenceClass::Inferred);
    assert_eq!(request.reconstructed, Some(false));
    assert_eq!(request.truncated, Some(false));
    assert_eq!(request.masked, Some(false));
    assert_eq!(response.reconstructed, None);
    assert_eq!(response.truncated, None);
    assert_eq!(response.masked, None);
}

#[test]
fn wrong_typed_status_is_null_with_an_explicit_warning() {
    let dir = tempdir().unwrap();
    let index = EventIndex::open(&dir.path().join("session.sqlite")).unwrap();
    let session = Uuid::new_v4();
    index
        .insert(&event(
            session,
            1,
            "network.request",
            json!({"request_id": "request-1", "raw": "GET / HTTP/1.1\r\n\r\n"}),
        ))
        .unwrap();
    index
        .insert(&event(
            session,
            2,
            "network.response",
            json!({"request_id": "request-1", "status": "200", "raw": "HTTP/1.1 200 OK\r\n\r\n"}),
        ))
        .unwrap();

    let detail = index.get_exchange(session, "request-1").unwrap().unwrap();
    assert_eq!(detail.status, None);
    assert_eq!(detail.warning.as_deref(), Some("invalid_status"));
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

#[test]
fn endpoint_summaries_apply_the_same_global_query_as_exchange_pages() {
    let dir = tempdir().unwrap();
    let index = EventIndex::open(&dir.path().join("session.sqlite")).unwrap();
    let session = Uuid::new_v4();
    index
        .insert(&event(
            session,
            1,
            "network.request",
            json!({
                "request_id": "request-1", "host": "api.example.test",
                "ip": "198.51.100.8", "method": "POST", "path": "/wallet",
                "protocol": "HTTP/2", "raw": "POST /wallet HTTP/2\r\n\r\n"
            }),
        ))
        .unwrap();

    let endpoints = index.list_endpoints(session, "POST", 2_000).unwrap();
    assert_eq!(endpoints.len(), 2);
    assert!(endpoints.iter().all(|endpoint| endpoint.count == 1));
}

#[test]
fn endpoint_summary_limit_bounds_the_combined_domain_and_ip_result() {
    let dir = tempdir().unwrap();
    let index = EventIndex::open(&dir.path().join("session.sqlite")).unwrap();
    let session = Uuid::new_v4();
    index
        .insert(&event(
            session,
            1,
            "network.request",
            json!({
                "request_id": "request-1", "host": "api.example.test",
                "ip": "198.51.100.8", "method": "GET", "path": "/",
                "protocol": "HTTP/1.1", "raw": "GET / HTTP/1.1\r\n\r\n"
            }),
        ))
        .unwrap();

    let endpoints = index.list_endpoints(session, "", 1).unwrap();
    assert_eq!(endpoints.len(), 1);
}

#[test]
fn live_query_repairs_corrupted_response_provenance_from_events() {
    let dir = tempdir().unwrap();
    let database = dir.path().join("session.sqlite");
    let index = EventIndex::open(&database).unwrap();
    let session = Uuid::new_v4();
    index
        .insert(&event(
            session,
            1,
            "network.request",
            json!({"request_id": "request-1", "raw": "GET / HTTP/1.1\r\n\r\n"}),
        ))
        .unwrap();
    let mut response = event(
        session,
        2,
        "network.response",
        json!({"request_id": "request-1", "status": 200, "raw": "HTTP/1.1 200 OK\r\n\r\n"}),
    );
    response.raw_ref = Some(RawArtifactRef {
        relative_path: "objects/sha256/fixture".into(),
        offset: 0,
        length: 19,
        sha256: Some("fixture".into()),
    });
    index.insert(&response).unwrap();

    rusqlite::Connection::open(&database)
        .unwrap()
        .execute(
            "UPDATE exchanges SET response_artifact_json = 'not-json' WHERE session_id = ?1",
            [session.to_string()],
        )
        .unwrap();

    let page = index.page_exchanges(session, "", None, 0, 50).unwrap();
    assert!(page.exchanges[0].request_raw.is_none());
    assert!(page.exchanges[0].response_raw.is_none());
    let repaired = index.get_exchange(session, "request-1").unwrap().unwrap();
    assert_eq!(
        repaired.response_raw.unwrap().artifact.unwrap().sha256,
        Some("fixture".into())
    );
}

#[test]
fn live_query_rebuilds_corrupted_evidence_from_the_authoritative_event() {
    let dir = tempdir().unwrap();
    let database = dir.path().join("session.sqlite");
    let index = EventIndex::open(&database).unwrap();
    let session = Uuid::new_v4();
    index
        .insert(&event(
            session,
            1,
            "network.request",
            json!({"request_id": "request-1", "raw": "GET / HTTP/1.1\r\n\r\n"}),
        ))
        .unwrap();

    rusqlite::Connection::open(&database)
        .unwrap()
        .execute(
            "UPDATE exchanges SET evidence = 'unknown-fixture' WHERE session_id = ?1",
            [session.to_string()],
        )
        .unwrap();

    let page = index.page_exchanges(session, "", None, 0, 50).unwrap();
    assert_eq!(page.exchanges[0].evidence, EvidenceClass::Observed);
}

#[test]
fn exchange_pages_are_capped_and_deterministically_ordered() {
    let dir = tempdir().unwrap();
    let index = EventIndex::open(&dir.path().join("session.sqlite")).unwrap();
    let session = Uuid::new_v4();
    for sequence in 1..=502 {
        let mut request = event(
            session,
            sequence,
            "network.request",
            json!({
                "request_id": format!("request-{:03}", 503 - sequence),
                "host": "api.example.test",
                "raw": "GET / HTTP/1.1\r\n\r\n"
            }),
        );
        request.host_time_ns = 1_784_730_000_100_000_000;
        index.insert(&request).unwrap();
    }

    let first = index
        .page_exchanges(session, "", None, 0, u64::MAX)
        .unwrap();
    assert_eq!(first.total, 502);
    assert_eq!(first.exchanges.len(), 500);
    assert_eq!(first.exchanges.first().unwrap().request_id, "request-502");
    assert_eq!(first.exchanges.last().unwrap().request_id, "request-003");

    let second = index.page_exchanges(session, "", None, 500, 500).unwrap();
    assert_eq!(
        second
            .exchanges
            .iter()
            .map(|exchange| exchange.request_id.as_str())
            .collect::<Vec<_>>(),
        ["request-002", "request-001"]
    );
}

#[test]
fn response_before_request_materializes_one_complete_exchange() {
    let dir = tempdir().unwrap();
    let index = EventIndex::open(&dir.path().join("session.sqlite")).unwrap();
    let session = Uuid::new_v4();
    index
        .insert(&event(
            session,
            2,
            "network.response",
            json!({
                "request_id": "request-1", "status": 204,
                "raw": "HTTP/1.1 204 No Content\r\n\r\n"
            }),
        ))
        .unwrap();
    let response_only = index.get_exchange(session, "request-1").unwrap().unwrap();
    assert!(response_only.request_raw.is_none());
    assert_eq!(
        response_only.response_raw.as_ref().unwrap().content,
        "HTTP/1.1 204 No Content\r\n\r\n"
    );
    index
        .insert(&event(
            session,
            1,
            "network.request",
            json!({
                "request_id": "request-1", "method": "GET", "host": "api.example.test",
                "raw": "GET / HTTP/1.1\r\nHost: api.example.test\r\n\r\n"
            }),
        ))
        .unwrap();

    let page = index.page_exchanges(session, "", None, 0, 50).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.exchanges[0].request_sequence, Some(1));
    assert_eq!(page.exchanges[0].response_sequence, Some(2));
    assert_eq!(page.exchanges[0].status, Some(204));
    assert_eq!(page.exchanges[0].warning, None);
}

#[test]
fn selected_exchange_preserves_missing_raw_payloads_as_absent() {
    let dir = tempdir().unwrap();
    let index = EventIndex::open(&dir.path().join("session.sqlite")).unwrap();
    let session = Uuid::new_v4();
    index
        .insert(&event(
            session,
            1,
            "network.request",
            json!({"request_id": "request-1", "method": "GET"}),
        ))
        .unwrap();
    index
        .insert(&event(
            session,
            2,
            "network.response",
            json!({"request_id": "request-1", "status": 200}),
        ))
        .unwrap();

    let detail = index.get_exchange(session, "request-1").unwrap().unwrap();
    assert!(detail.request_raw.is_none());
    assert!(detail.response_raw.is_none());
}

#[test]
fn out_of_range_response_status_is_null_with_an_explicit_warning() {
    let dir = tempdir().unwrap();
    let index = EventIndex::open(&dir.path().join("session.sqlite")).unwrap();
    let session = Uuid::new_v4();
    index
        .insert(&event(
            session,
            1,
            "network.request",
            json!({"request_id": "request-1", "raw": "GET / HTTP/1.1\r\n\r\n"}),
        ))
        .unwrap();
    index
        .insert(&event(
            session,
            2,
            "network.response",
            json!({
                "request_id": "request-1", "status": 700,
                "raw": "HTTP/1.1 invalid\r\n\r\n"
            }),
        ))
        .unwrap();

    let detail = index.get_exchange(session, "request-1").unwrap().unwrap();
    assert_eq!(detail.status, None);
    assert_eq!(detail.warning.as_deref(), Some("invalid_status"));
}

#[test]
fn failed_event_insert_does_not_partially_update_the_exchange() {
    let dir = tempdir().unwrap();
    let index = EventIndex::open(&dir.path().join("session.sqlite")).unwrap();
    let session = Uuid::new_v4();
    index
        .insert(&event(
            session,
            1,
            "network.request",
            json!({"request_id": "request-1", "raw": "GET / HTTP/1.1\r\n\r\n"}),
        ))
        .unwrap();

    let duplicate_sequence = event(
        session,
        1,
        "network.response",
        json!({"request_id": "request-1", "status": 200, "raw": "HTTP/1.1 200 OK\r\n\r\n"}),
    );
    assert!(index.insert(&duplicate_sequence).is_err());

    let page = index.page_exchanges(session, "", None, 0, 50).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.exchanges[0].response_sequence, None);
    assert_eq!(
        page.exchanges[0].warning.as_deref(),
        Some("response_missing")
    );
}

#[test]
fn materialization_failure_rolls_back_the_immutable_event_insert() {
    let dir = tempdir().unwrap();
    let database = dir.path().join("session.sqlite");
    let index = EventIndex::open(&database).unwrap();
    let session = Uuid::new_v4();
    rusqlite::Connection::open(&database)
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER reject_exchange_fixture
             BEFORE INSERT ON exchanges
             BEGIN
               SELECT RAISE(ABORT, 'fixture materialization failure');
             END;",
        )
        .unwrap();

    let request = event(
        session,
        1,
        "network.request",
        json!({"request_id": "request-1", "raw": "GET / HTTP/1.1\r\n\r\n"}),
    );
    assert!(index.insert(&request).is_err());
    assert_eq!(index.page(session, 0, 50).unwrap().total, 0);
    assert_eq!(
        index
            .page_exchanges(session, "", None, 0, 50)
            .unwrap()
            .total,
        0
    );
}

#[test]
fn opening_a_legacy_event_index_backfills_exchanges_idempotently() {
    let dir = tempdir().unwrap();
    let database = dir.path().join("session.sqlite");
    let session = Uuid::new_v4();
    let request = event(
        session,
        1,
        "network.request",
        json!({
            "request_id": "legacy-request", "method": "GET", "host": "legacy.example.test",
            "raw": "GET / HTTP/1.1\r\nHost: legacy.example.test\r\n\r\n"
        }),
    );
    let response = event(
        session,
        2,
        "network.response",
        json!({
            "request_id": "legacy-request", "status": 200,
            "raw": "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"
        }),
    );
    let connection = rusqlite::Connection::open(&database).unwrap();
    connection
        .execute_batch(include_str!("../migrations/0001_events.sql"))
        .unwrap();
    for legacy_event in [&request, &response] {
        connection
            .execute(
                "INSERT INTO events (
                    session_id, sequence, host_time_ns, provider_id,
                    evidence, kind, process_name, event_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    session.to_string(),
                    legacy_event.sequence as i64,
                    legacy_event.host_time_ns,
                    legacy_event.provider_id,
                    "observed",
                    legacy_event.kind,
                    legacy_event.process_name,
                    serde_json::to_string(legacy_event).unwrap(),
                ],
            )
            .unwrap();
    }
    drop(connection);

    let index = EventIndex::open(&database).unwrap();
    let detail = index
        .get_exchange(session, "legacy-request")
        .unwrap()
        .unwrap();
    assert_eq!(detail.status, Some(200));
    drop(index);

    let reopened = EventIndex::open(&database).unwrap();
    assert_eq!(
        reopened
            .page_exchanges(session, "", None, 0, 50)
            .unwrap()
            .total,
        1
    );
}

#[test]
fn legacy_backfill_failure_rolls_back_all_materialized_rows() {
    let dir = tempdir().unwrap();
    let database = dir.path().join("session.sqlite");
    let session = Uuid::new_v4();
    let request = event(
        session,
        1,
        "network.request",
        json!({"request_id": "legacy-request", "raw": "GET / HTTP/1.1\r\n\r\n"}),
    );
    let connection = rusqlite::Connection::open(&database).unwrap();
    connection
        .execute_batch(include_str!("../migrations/0001_events.sql"))
        .unwrap();
    connection
        .execute(
            "INSERT INTO events (
                session_id, sequence, host_time_ns, provider_id,
                evidence, kind, process_name, event_json
             ) VALUES (?1, 1, ?2, 'fake', 'observed', 'network.request', NULL, ?3)",
            rusqlite::params![
                session.to_string(),
                request.host_time_ns,
                serde_json::to_string(&request).unwrap()
            ],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO events (
                session_id, sequence, host_time_ns, provider_id,
                evidence, kind, process_name, event_json
             ) VALUES (?1, 2, ?2, 'fake', 'observed', 'network.response', NULL, 'not-json')",
            rusqlite::params![session.to_string(), request.host_time_ns + 1],
        )
        .unwrap();
    drop(connection);

    assert!(EventIndex::open(&database).is_err());
    let connection = rusqlite::Connection::open(&database).unwrap();
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM exchanges", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn reopening_repairs_a_nonempty_partial_exchange_index() {
    let dir = tempdir().unwrap();
    let database = dir.path().join("session.sqlite");
    let session = Uuid::new_v4();
    let index = EventIndex::open(&database).unwrap();
    for sequence in 1..=2 {
        index
            .insert(&event(
                session,
                sequence,
                "network.request",
                json!({
                    "request_id": format!("request-{sequence}"),
                    "host": "api.example.test",
                    "raw": "GET / HTTP/1.1\r\n\r\n"
                }),
            ))
            .unwrap();
    }
    drop(index);
    rusqlite::Connection::open(&database)
        .unwrap()
        .execute("DELETE FROM exchanges WHERE request_id = 'request-2'", [])
        .unwrap();

    let repaired = EventIndex::open(&database).unwrap();
    let page = repaired.page_exchanges(session, "", None, 0, 50).unwrap();
    assert_eq!(page.total, 2);
    assert_eq!(page.exchanges.len(), 2);
}

#[test]
fn live_queries_repair_corrupted_persisted_numbers_and_flags() {
    let dir = tempdir().unwrap();
    let database = dir.path().join("session.sqlite");
    let session = Uuid::new_v4();
    let index = EventIndex::open(&database).unwrap();
    index
        .insert(&event(
            session,
            1,
            "network.request",
            json!({
                "request_id": "request-1", "raw": "GET / HTTP/1.1\r\n\r\n",
                "reconstructed": false
            }),
        ))
        .unwrap();
    rusqlite::Connection::open(&database)
        .unwrap()
        .execute(
            "UPDATE exchanges SET request_sequence = -1 WHERE session_id = ?1",
            [session.to_string()],
        )
        .unwrap();
    assert_eq!(
        index
            .page_exchanges(session, "", None, 0, 50)
            .unwrap()
            .exchanges[0]
            .request_sequence,
        Some(1)
    );

    rusqlite::Connection::open(&database)
        .unwrap()
        .execute(
            "UPDATE exchanges SET request_sequence = 1, request_reconstructed_state = 2 WHERE session_id = ?1",
            [session.to_string()],
        )
        .unwrap();
    assert_eq!(
        index
            .get_exchange(session, "request-1")
            .unwrap()
            .unwrap()
            .request_raw
            .unwrap()
            .reconstructed,
        Some(false)
    );
}

#[cfg(unix)]
#[test]
fn sqlite_index_refuses_a_final_component_symlink() {
    use std::os::unix::fs::symlink;

    let dir = tempdir().unwrap();
    let target = dir.path().join("outside.sqlite");
    std::fs::write(&target, b"unchanged").unwrap();
    let database = dir.path().join("session.sqlite");
    symlink(&target, &database).unwrap();

    let error = EventIndex::open(&database).err().unwrap();
    assert!(error.to_string().contains("refusing symlink SQLite index"));
    assert_eq!(std::fs::read(&target).unwrap(), b"unchanged");
}

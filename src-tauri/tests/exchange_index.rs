use proxbot_lib::{
    domain::{EvidenceClass, ParseStatus, ProviderEvent, RawArtifactRef},
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
    assert!(detail.request_raw.as_ref().unwrap().reconstructed);

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
fn exchange_query_reports_corrupted_response_provenance() {
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
    assert!(index.get_exchange(session, "request-1").is_err());
}

#[test]
fn exchange_query_never_relabels_unknown_evidence_as_observed() {
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

    assert!(index.page_exchanges(session, "", None, 0, 50).is_err());
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
    assert_eq!(first.exchanges.first().unwrap().request_id, "request-001");
    assert_eq!(first.exchanges.last().unwrap().request_id, "request-500");

    let second = index.page_exchanges(session, "", None, 500, 500).unwrap();
    assert_eq!(
        second
            .exchanges
            .iter()
            .map(|exchange| exchange.request_id.as_str())
            .collect::<Vec<_>>(),
        ["request-501", "request-502"]
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
fn invalid_response_status_is_null_with_an_explicit_warning() {
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
                "request_id": "request-1", "status": 70_000,
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

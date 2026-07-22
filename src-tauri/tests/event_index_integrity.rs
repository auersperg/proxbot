use proxbot_lib::{
    capture::run_fake_capture,
    domain::{EvidenceClass, ParseStatus, ProviderEvent},
    store::EventIndex,
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

fn paired_events(session_id: Uuid) -> (ProviderEvent, ProviderEvent) {
    let request = event(
        session_id,
        1,
        "network.request",
        json!({
            "request_id": "request-1",
            "method": "GET",
            "scheme": "https",
            "host": "original.example.test",
            "path": "/original",
            "raw": "GET /original HTTP/1.1\r\nHost: original.example.test\r\n\r\n",
            "media_type": "application/http",
            "reconstructed": true,
            "truncated": false,
            "masked": false
        }),
    );
    let response = event(
        session_id,
        2,
        "network.response",
        json!({
            "request_id": "request-1",
            "status": 200,
            "raw": "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}",
            "media_type": "application/http",
            "reconstructed": true,
            "truncated": false,
            "masked": false
        }),
    );
    (request, response)
}

#[test]
fn reopen_repairs_same_cardinality_exchange_content_from_events() {
    let root = tempdir().unwrap();
    let database = root.path().join("session.sqlite");
    let session_id = Uuid::new_v4();
    let (request, response) = paired_events(session_id);

    let index = EventIndex::open(&database).unwrap();
    index.insert(&request).unwrap();
    index.insert(&response).unwrap();
    drop(index);

    let connection = rusqlite::Connection::open(&database).unwrap();
    connection
        .execute(
            "UPDATE exchanges
             SET status = 599,
                 request_raw = 'corrupted request',
                 response_raw = 'corrupted response'
             WHERE session_id = ?1 AND request_id = 'request-1'",
            [session_id.to_string()],
        )
        .unwrap();
    let row_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM exchanges", [], |row| row.get(0))
        .unwrap();
    assert_eq!(row_count, 1, "the corruption must preserve cardinality");
    drop(connection);

    let repaired = EventIndex::open(&database).unwrap();
    let detail = repaired
        .get_exchange(session_id, "request-1")
        .unwrap()
        .unwrap();
    assert_eq!(detail.status, Some(200));
    assert_eq!(
        detail.request_raw.unwrap().content,
        "GET /original HTTP/1.1\r\nHost: original.example.test\r\n\r\n"
    );
    assert_eq!(
        detail.response_raw.unwrap().content,
        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}"
    );
}

#[test]
fn cached_index_repairs_same_cardinality_exchange_content_before_reading() {
    let root = tempdir().unwrap();
    let database = root.path().join("session.sqlite");
    let session_id = Uuid::new_v4();
    let (request, response) = paired_events(session_id);
    let index = EventIndex::open(&database).unwrap();
    index.insert(&request).unwrap();
    index.insert(&response).unwrap();

    rusqlite::Connection::open(&database)
        .unwrap()
        .execute(
            "UPDATE exchanges SET status = 599, response_raw = 'corrupted response'
             WHERE session_id = ?1 AND request_id = 'request-1'",
            [session_id.to_string()],
        )
        .unwrap();

    let detail = index
        .get_exchange(session_id, "request-1")
        .unwrap()
        .unwrap();
    assert_eq!(detail.status, Some(200));
    assert_eq!(
        detail.response_raw.unwrap().content,
        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}"
    );
}

#[test]
fn normal_insert_does_not_clear_a_preexisting_dirty_event_state() {
    let root = tempdir().unwrap();
    let database = root.path().join("legacy.sqlite");
    let session_id = Uuid::new_v4();
    let (request, response) = paired_events(session_id);
    let index = EventIndex::open(&database).unwrap();
    index.insert(&request).unwrap();
    index.insert(&response).unwrap();

    let mut updated_response = response;
    updated_response.payload = json!({
        "request_id": "request-1",
        "status": 202,
        "raw": "HTTP/1.1 202 Accepted\r\n\r\n"
    });
    rusqlite::Connection::open(&database)
        .unwrap()
        .execute(
            "UPDATE events SET event_json = ?1
             WHERE session_id = ?2 AND provider_id = 'fake' AND sequence = 2",
            rusqlite::params![
                serde_json::to_string(&updated_response).unwrap(),
                session_id.to_string()
            ],
        )
        .unwrap();

    index
        .insert(&event(
            session_id,
            3,
            "fixture.after-corruption",
            json!({"fixture": true}),
        ))
        .unwrap();
    let detail = index
        .get_exchange(session_id, "request-1")
        .unwrap()
        .unwrap();
    assert_eq!(detail.status, Some(202));
    drop(index);
    let reopened = EventIndex::open(&database).unwrap();
    assert_eq!(
        reopened
            .get_exchange(session_id, "request-1")
            .unwrap()
            .unwrap()
            .status,
        Some(202)
    );
}

#[test]
fn cached_legacy_index_restores_redundant_event_columns_from_event_json() {
    let root = tempdir().unwrap();
    let database = root.path().join("legacy.sqlite");
    let session_id = Uuid::new_v4();
    let other_session = Uuid::new_v4();
    let (request, response) = paired_events(session_id);
    let index = EventIndex::open(&database).unwrap();
    index.insert(&request).unwrap();
    index.insert(&response).unwrap();

    rusqlite::Connection::open(&database)
        .unwrap()
        .execute(
            "UPDATE events
             SET session_id = ?1, host_time_ns = -1, provider_id = 'corrupted',
                 evidence = 'inferred', kind = 'fixture.corrupted'
             WHERE session_id = ?2 AND provider_id = 'fake' AND sequence = 1",
            rusqlite::params![other_session.to_string(), session_id.to_string()],
        )
        .unwrap();

    let page = index.page(session_id, 0, 50).unwrap();
    assert_eq!(page.total, 2);
    assert!(page.events.iter().all(|item| item.session_id == session_id));
    let connection = rusqlite::Connection::open(&database).unwrap();
    let restored: (String, i64, String, String, String) = connection
        .query_row(
            "SELECT session_id, host_time_ns, provider_id, evidence, kind
             FROM events WHERE sequence = 1",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(restored.0, session_id.to_string());
    assert_eq!(restored.1, request.host_time_ns);
    assert_eq!(restored.2, "fake");
    assert_eq!(restored.3, "observed");
    assert_eq!(restored.4, "network.request");
}

#[test]
fn reopen_rebuilds_legacy_exchange_after_same_cardinality_event_json_update() {
    let root = tempdir().unwrap();
    // A database outside the session/database layout has no authoritative JSONL
    // source and exercises the legacy SQLite-only repair path.
    let database = root.path().join("legacy.sqlite");
    let session_id = Uuid::new_v4();
    let (request, response) = paired_events(session_id);

    let index = EventIndex::open(&database).unwrap();
    index.insert(&request).unwrap();
    index.insert(&response).unwrap();
    drop(index);

    let mut updated_response = response;
    updated_response.payload = json!({
        "request_id": "request-1",
        "status": 202,
        "raw": "HTTP/1.1 202 Accepted\r\nContent-Length: 7\r\n\r\nupdated",
        "media_type": "application/http",
        "reconstructed": false,
        "truncated": false,
        "masked": false
    });
    let connection = rusqlite::Connection::open(&database).unwrap();
    connection
        .execute(
            "UPDATE events SET event_json = ?1
             WHERE session_id = ?2 AND provider_id = 'fake' AND sequence = 2",
            rusqlite::params![
                serde_json::to_string(&updated_response).unwrap(),
                session_id.to_string()
            ],
        )
        .unwrap();
    let event_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
        .unwrap();
    assert_eq!(event_count, 2, "the update must preserve event cardinality");
    let content_state: String = connection
        .query_row(
            "SELECT value FROM index_metadata WHERE key = 'events_content_state'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(content_state, "dirty");
    drop(connection);

    let rebuilt = EventIndex::open(&database).unwrap();
    let detail = rebuilt
        .get_exchange(session_id, "request-1")
        .unwrap()
        .unwrap();
    assert_eq!(detail.status, Some(202));
    assert_eq!(
        detail.response_raw.unwrap().content,
        "HTTP/1.1 202 Accepted\r\nContent-Length: 7\r\n\r\nupdated"
    );
}

#[tokio::test]
async fn fake_capture_reopen_restores_same_count_event_json_corruption_from_jsonl() {
    let root = tempdir().unwrap();
    let provider =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../sidecars/ios-provider");
    let summary = run_fake_capture(root.path(), &provider, 3).await.unwrap();
    let database = summary.session_dir.join("database/session.sqlite");

    // The first post-finalization open records the finalized JSONL hash.
    let initial = EventIndex::open(&database).unwrap();
    assert_eq!(initial.page(summary.session_id, 0, 50).unwrap().total, 3);
    drop(initial);

    let connection = rusqlite::Connection::open(&database).unwrap();
    connection
        .execute(
            "UPDATE events SET event_json = '{}'
             WHERE session_id = ?1 AND provider_id = 'fake' AND sequence = 1",
            [summary.session_id.to_string()],
        )
        .unwrap();
    let event_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        event_count, 3,
        "the corruption must preserve event cardinality"
    );
    drop(connection);

    let recovered = EventIndex::open(&database).unwrap();
    let page = recovered.page(summary.session_id, 0, 50).unwrap();
    assert_eq!(page.total, 3);
    let restored_request = page
        .events
        .iter()
        .find(|event| event.sequence == 1)
        .expect("the JSONL request event must be restored");
    assert_eq!(restored_request.kind, "network.request");
    assert_eq!(
        restored_request
            .payload
            .get("host")
            .and_then(|value| value.as_str()),
        Some("auth.privy.io")
    );
    let detail = recovered
        .get_exchange(summary.session_id, "request-000001")
        .unwrap()
        .unwrap();
    assert_eq!(detail.status, Some(200));
    assert!(
        detail
            .request_raw
            .unwrap()
            .content
            .contains("Host: auth.privy.io")
    );
}

#[cfg(unix)]
#[test]
fn sqlite_index_refuses_symlinked_database_directory_or_ancestor_without_touching_targets() {
    use std::os::unix::fs::symlink;

    let root = tempdir().unwrap();

    let external_database = root.path().join("outside-database");
    std::fs::create_dir(&external_database).unwrap();
    let database_sentinel = external_database.join("sentinel.txt");
    std::fs::write(&database_sentinel, b"database target unchanged").unwrap();
    let session = root.path().join("session");
    std::fs::create_dir(&session).unwrap();
    symlink(&external_database, session.join("database")).unwrap();

    let database_path = session.join("database/session.sqlite");
    let error = EventIndex::open(&database_path).err().unwrap();
    assert!(error.to_string().contains("SQLite ancestor"));
    assert_eq!(
        std::fs::read(&database_sentinel).unwrap(),
        b"database target unchanged"
    );
    assert!(!external_database.join("session.sqlite").exists());

    let external_session = root.path().join("outside-session");
    let external_session_database = external_session.join("database");
    std::fs::create_dir_all(&external_session_database).unwrap();
    let ancestor_sentinel = external_session.join("sentinel.txt");
    std::fs::write(&ancestor_sentinel, b"ancestor target unchanged").unwrap();
    let linked_session = root.path().join("linked-session");
    symlink(&external_session, &linked_session).unwrap();

    let ancestor_database_path = linked_session.join("database/session.sqlite");
    let error = EventIndex::open(&ancestor_database_path).err().unwrap();
    assert!(error.to_string().contains("SQLite ancestor"));
    assert_eq!(
        std::fs::read(&ancestor_sentinel).unwrap(),
        b"ancestor target unchanged"
    );
    assert!(!external_session_database.join("session.sqlite").exists());
}

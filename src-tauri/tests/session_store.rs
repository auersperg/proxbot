use std::os::unix::fs::PermissionsExt;

use serde_json::json;
use tempfile::tempdir;
use trace_lab_lib::domain::{EvidenceClass, ParseStatus, ProviderEvent};
use trace_lab_lib::store::{EventIndex, SessionStore};
use uuid::Uuid;

fn fixture_event(session_id: Uuid, sequence: u64) -> ProviderEvent {
    ProviderEvent {
        schema_version: 1,
        provider_id: "fake".into(),
        provider_version: "1.0.0".into(),
        session_id,
        sequence,
        source_time_ns: sequence as i64,
        host_time_ns: sequence as i64 + 10,
        monotonic_time_ns: Some(sequence as i64),
        device_id: Some("fixture".into()),
        process_id: Some(7),
        process_name: Some("FixtureApp".into()),
        evidence: EvidenceClass::Observed,
        kind: "fixture.event".into(),
        payload: json!({"sequence": sequence}),
        raw_ref: None,
        parse_status: ParseStatus::Parsed,
    }
}

#[test]
fn finalization_atomically_promotes_artifacts_and_writes_checksums() {
    let root = tempdir().unwrap();
    let session_id = Uuid::new_v4();
    let mut store = SessionStore::create(root.path(), session_id).unwrap();
    store.append(&fixture_event(session_id, 1)).unwrap();
    let summary = store.finalize().unwrap();

    assert_eq!(summary.event_count, 1);
    assert!(
        summary
            .session_dir
            .join("events/provider-events.jsonl")
            .exists()
    );
    assert!(
        !summary
            .session_dir
            .join("events/provider-events.jsonl.partial")
            .exists()
    );
    assert!(summary.session_dir.join("manifest.json").exists());
    assert!(summary.session_dir.join("checksums.sha256").exists());
    assert_eq!(
        summary.session_dir.metadata().unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        summary
            .session_dir
            .join("events/provider-events.jsonl")
            .metadata()
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn sqlite_index_returns_stable_pages() {
    let root = tempdir().unwrap();
    let session_id = Uuid::new_v4();
    let index = EventIndex::open(&root.path().join("session.sqlite")).unwrap();
    for sequence in 0..5 {
        index.insert(&fixture_event(session_id, sequence)).unwrap();
    }

    let page = index.page(session_id, 2, 2).unwrap();
    assert_eq!(page.total, 5);
    assert_eq!(
        page.events
            .iter()
            .map(|event| event.sequence)
            .collect::<Vec<_>>(),
        vec![2, 3]
    );
}

#[test]
fn sqlite_index_filters_by_session() {
    let root = tempdir().unwrap();
    let first = Uuid::new_v4();
    let second = Uuid::new_v4();
    let index = EventIndex::open(&root.path().join("session.sqlite")).unwrap();
    index.insert(&fixture_event(first, 1)).unwrap();
    index.insert(&fixture_event(second, 2)).unwrap();

    let page = index.page(first, 0, 50).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.events[0].session_id, first);
}

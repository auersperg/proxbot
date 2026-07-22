use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
};

use proxbot_lib::domain::{EvidenceClass, ParseStatus, ProviderEvent};
use proxbot_lib::store::{EventIndex, SessionStore};
use serde_json::json;
use sha2::{Digest, Sha256};
use tempfile::tempdir;
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
    assert!(!summary.session_dir.join("manifest.json.partial").exists());
    assert!(
        !summary
            .session_dir
            .join("checksums.sha256.partial")
            .exists()
    );
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(summary.session_dir.join("manifest.json")).unwrap())
            .unwrap();
    assert_eq!(manifest["status"], "ready");
    assert_eq!(manifest["event_count"], 1);
    let event_bytes = fs::read(summary.session_dir.join("events/provider-events.jsonl")).unwrap();
    let expected_checksum = hex::encode(Sha256::digest(&event_bytes));
    assert_eq!(
        fs::read_to_string(summary.session_dir.join("checksums.sha256")).unwrap(),
        format!("{expected_checksum}  events/provider-events.jsonl\n")
    );
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
    for artifact in ["manifest.json", "checksums.sha256"] {
        assert_eq!(
            summary
                .session_dir
                .join(artifact)
                .metadata()
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600,
            "{artifact} must remain owner-only"
        );
    }
}

#[test]
fn checkpoint_makes_appended_events_visible_before_finalization() {
    let root = tempdir().unwrap();
    let session_id = Uuid::new_v4();
    let mut store = SessionStore::create(root.path(), session_id).unwrap();
    store.append(&fixture_event(session_id, 0)).unwrap();
    store.append(&fixture_event(session_id, 1)).unwrap();

    store.checkpoint().unwrap();

    let partial = store
        .session_dir()
        .join("events/provider-events.jsonl.partial");
    let persisted = fs::read_to_string(partial).unwrap();
    assert_eq!(persisted.lines().count(), 2);
    assert!(
        persisted
            .lines()
            .all(|line| serde_json::from_str::<ProviderEvent>(line).is_ok())
    );
}

#[test]
fn creation_refuses_preexisting_event_symlink_without_changing_target() {
    let root = tempdir().unwrap();
    let target = root.path().join("outside.txt");
    fs::write(&target, b"must remain unchanged").unwrap();

    let session_id = Uuid::new_v4();
    let events_dir = root.path().join(session_id.to_string()).join("events");
    fs::create_dir_all(&events_dir).unwrap();
    symlink(&target, events_dir.join("provider-events.jsonl.partial")).unwrap();

    let error = SessionStore::create(root.path(), session_id)
        .err()
        .expect("a final-component symlink must be refused");

    assert!(!error.to_string().is_empty());
    assert_eq!(fs::read(&target).unwrap(), b"must remain unchanged");
    assert!(!store_manifest_path(root.path(), session_id).exists());
}

#[test]
fn creation_refuses_a_preexisting_session_directory() {
    let root = tempdir().unwrap();
    let session_id = Uuid::new_v4();
    let events_dir = root.path().join(session_id.to_string()).join("events");
    fs::create_dir_all(&events_dir).unwrap();
    let partial = events_dir.join("provider-events.jsonl.partial");
    fs::write(&partial, b"stale contents").unwrap();
    fs::set_permissions(&partial, fs::Permissions::from_mode(0o666)).unwrap();

    let error = SessionStore::create(root.path(), session_id).err().unwrap();
    assert!(!error.to_string().is_empty());
    assert_eq!(fs::read(&partial).unwrap(), b"stale contents");
}

#[test]
fn finalization_refuses_preexisting_manifest_symlink_without_changing_target() {
    let root = tempdir().unwrap();
    let session_id = Uuid::new_v4();
    let mut store = SessionStore::create(root.path(), session_id).unwrap();
    store.append(&fixture_event(session_id, 0)).unwrap();

    let target = root.path().join("outside-manifest.txt");
    fs::write(&target, b"must remain unchanged").unwrap();
    symlink(&target, store.session_dir().join("manifest.json.partial")).unwrap();

    let error = store
        .finalize()
        .expect_err("a final-component symlink must be refused");

    assert!(!error.to_string().is_empty());
    assert_eq!(fs::read(&target).unwrap(), b"must remain unchanged");
    assert!(!store_manifest_path(root.path(), session_id).exists());
}

fn store_manifest_path(root: &std::path::Path, session_id: Uuid) -> std::path::PathBuf {
    root.join(session_id.to_string()).join("manifest.json")
}

#[test]
fn finalization_refuses_preexisting_checksum_symlink_without_changing_target() {
    let root = tempdir().unwrap();
    let session_id = Uuid::new_v4();
    let mut store = SessionStore::create(root.path(), session_id).unwrap();
    store.append(&fixture_event(session_id, 0)).unwrap();

    let target = root.path().join("outside-checksums.txt");
    fs::write(&target, b"must remain unchanged").unwrap();
    symlink(&target, store.session_dir().join("checksums.sha256")).unwrap();

    let error = store
        .finalize()
        .expect_err("a final-component symlink must be refused");

    assert!(!error.to_string().is_empty());
    assert_eq!(fs::read(&target).unwrap(), b"must remain unchanged");
    assert!(!store_manifest_path(root.path(), session_id).exists());
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

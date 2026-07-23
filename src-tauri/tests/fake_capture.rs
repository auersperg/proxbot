use proxbot_lib::{capture::run_fake_capture, store::EventIndex};
use tempfile::tempdir;

#[tokio::test]
async fn fake_capture_persists_and_indexes_every_event() {
    let root = tempdir().unwrap();
    let provider =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../sidecars/ios-provider");
    let summary = run_fake_capture(root.path(), &provider, 512).await.unwrap();

    assert_eq!(summary.event_count, 512);
    assert_eq!(summary.indexed_count, 512);
    assert_eq!(summary.first_sequence, 0);
    assert_eq!(summary.last_sequence, 511);
    assert!(summary.session_dir.join("manifest.json").exists());
    let lines = std::fs::read_to_string(summary.session_dir.join("events/provider-events.jsonl"))
        .unwrap()
        .lines()
        .count();
    assert_eq!(lines, 512);

    let index = EventIndex::open(&summary.session_dir.join("database/session.sqlite")).unwrap();
    assert_eq!(index.page(summary.session_id, 0, 50).unwrap().total, 512);
}

#[tokio::test]
async fn deleted_sqlite_index_is_rebuilt_from_authoritative_jsonl() {
    let root = tempdir().unwrap();
    let provider =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../sidecars/ios-provider");
    let summary = run_fake_capture(root.path(), &provider, 9).await.unwrap();
    let database = summary.session_dir.join("database/session.sqlite");
    std::fs::remove_file(&database).unwrap();

    let rebuilt = EventIndex::open(&database).unwrap();
    assert_eq!(rebuilt.page(summary.session_id, 0, 50).unwrap().total, 9);
    assert!(database.exists());
}

#[tokio::test]
async fn fake_capture_rejects_zero_events_before_creating_a_session() {
    let root = tempdir().unwrap();
    let provider =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../sidecars/ios-provider");
    let error = run_fake_capture(root.path(), &provider, 0)
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("count must be between 1 and 10000")
    );
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}

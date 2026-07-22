use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::{
    domain::SessionCoordinator,
    provider::{ProviderRuntime, ProviderSupervisor},
    store::{EventIndex, SessionStore},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureSummary {
    pub session_id: Uuid,
    pub session_dir: PathBuf,
    pub event_count: u64,
    pub indexed_count: u64,
    pub first_sequence: u64,
    pub last_sequence: u64,
}

pub async fn run_fake_capture(
    root: &Path,
    provider_project: &Path,
    count: u64,
) -> anyhow::Result<CaptureSummary> {
    let runtime = ProviderRuntime::discover(&[], provider_project.to_path_buf())?;
    run_fake_capture_with_runtime(root, &runtime, count).await
}

pub async fn run_fake_capture_with_runtime(
    root: &Path,
    runtime: &ProviderRuntime,
    count: u64,
) -> anyhow::Result<CaptureSummary> {
    anyhow::ensure!(
        (1..=10_000).contains(&count),
        "count must be between 1 and 10000"
    );
    let session_id = Uuid::new_v4();
    let mut coordinator = SessionCoordinator::new(session_id);
    coordinator.register_provider("fake")?;
    coordinator.prepare()?;
    coordinator.start()?;

    let mut store = SessionStore::create(root, session_id)?;
    let index = EventIndex::open(&store.session_dir().join("database/session.sqlite"))?;
    let socket_name = format!("proxbot-{}.sock", &session_id.simple().to_string()[..12]);
    let socket_path = std::env::temp_dir().join(socket_name);
    let events = ProviderSupervisor::run_fake(runtime, &socket_path, session_id, count).await?;

    anyhow::ensure!(
        events.len() == count as usize,
        "provider returned {} events; expected {count}",
        events.len()
    );
    for (expected, event) in events.iter().enumerate() {
        anyhow::ensure!(
            event.session_id == session_id,
            "provider event belongs to session {} instead of {session_id}",
            event.session_id
        );
        anyhow::ensure!(
            event.sequence == expected as u64,
            "provider sequence gap: expected {expected}, received {}",
            event.sequence
        );
    }

    // JSONL is the authoritative evidence stream. Persist the complete stream
    // before updating the derived SQLite index so a crash cannot leave SQLite
    // claiming that evidence exists when it has not reached stable storage.
    for event in &events {
        store.append(event)?;
    }
    store.checkpoint()?;

    for event in &events {
        index.insert(event)?;
    }

    coordinator.stop()?;
    coordinator.finalize()?;
    let first_sequence = events
        .first()
        .map(|event| event.sequence)
        .unwrap_or_default();
    let last_sequence = events
        .last()
        .map(|event| event.sequence)
        .unwrap_or_default();
    let finalized = store.finalize()?;

    Ok(CaptureSummary {
        session_id,
        session_dir: finalized.session_dir,
        event_count: finalized.event_count,
        indexed_count: events.len() as u64,
        first_sequence,
        last_sequence,
    })
}

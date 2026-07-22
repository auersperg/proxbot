use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Mutex,
};

use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, params,
};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::domain::ProviderEvent;

use super::{
    EndpointFilter, EndpointSummary, ExchangePage, ExchangeRow,
    exchange_index::{get_exchange, list_endpoints, materialize_event, page_exchanges},
};

#[derive(Debug, Clone, PartialEq)]
pub struct EventPage {
    pub events: Vec<ProviderEvent>,
    pub total: u64,
}

pub struct EventIndex {
    connection: Mutex<Connection>,
    database_path: PathBuf,
}

impl EventIndex {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        let database_parent = path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("SQLite index path has no parent"))?;
        for directory in [Some(database_parent), database_parent.parent()]
            .into_iter()
            .flatten()
        {
            let metadata = fs::symlink_metadata(directory)?;
            anyhow::ensure!(
                metadata.is_dir() && !metadata.file_type().is_symlink(),
                "refusing symlink or non-directory SQLite ancestor: {}",
                directory.display()
            );
        }
        let file_name = path
            .file_name()
            .ok_or_else(|| anyhow::anyhow!("SQLite index path has no filename"))?;
        let parent = fs::canonicalize(
            path.parent()
                .ok_or_else(|| anyhow::anyhow!("SQLite index path has no parent"))?,
        )?;
        let path = parent.join(file_name);
        if let Ok(metadata) = fs::symlink_metadata(&path) {
            anyhow::ensure!(
                !metadata.file_type().is_symlink(),
                "refusing symlink SQLite index: {}",
                path.display()
            );
        }
        let database_file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&path)?;
        database_file.set_permissions(fs::Permissions::from_mode(0o600))?;
        drop(database_file);
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW;
        let mut connection = Connection::open_with_flags(&path, flags)?;
        connection.execute_batch(include_str!("../../migrations/0001_events.sql"))?;
        connection.execute_batch(include_str!("../../migrations/0002_exchanges.sql"))?;
        ensure_exchange_columns(&connection)?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS index_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
             );",
        )?;
        install_integrity_triggers(&connection)?;
        repair_index(&mut connection, &path, true)?;
        Ok(Self {
            connection: Mutex::new(connection),
            database_path: path,
        })
    }

    pub fn insert(&self, event: &ProviderEvent) -> anyhow::Result<()> {
        let mut connection = self.connection.lock().expect("event index lock poisoned");
        loop {
            repair_dirty_content(&mut connection, &self.database_path)?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if !content_states_are_clean(&transaction)? {
                transaction.rollback()?;
                continue;
            }
            let exchange_existed = exchange_exists(&transaction, event)?;
            insert_event_row(&transaction, event)?;
            materialize_event(&transaction, event)?;
            advance_derived_metadata(&transaction, event, exchange_existed)?;
            transaction.commit()?;
            return Ok(());
        }
    }

    pub fn page(&self, session_id: Uuid, offset: u64, limit: u64) -> anyhow::Result<EventPage> {
        let limit = i64::try_from(limit)
            .map_err(|_| anyhow::anyhow!("event page limit exceeds SQLite INTEGER range"))?;
        let offset = i64::try_from(offset)
            .map_err(|_| anyhow::anyhow!("event page offset exceeds SQLite INTEGER range"))?;
        let session_id = session_id.to_string();
        self.read_consistent(|connection| {
            let total_i64 = connection.query_row(
                "SELECT COUNT(*) FROM events WHERE session_id = ?1",
                [&session_id],
                |row| row.get::<_, i64>(0),
            )?;
            let total = u64::try_from(total_i64)?;
            let mut statement = connection.prepare(
                "SELECT event_json
                 FROM events
                 WHERE session_id = ?1
                 ORDER BY host_time_ns, provider_id, sequence
                 LIMIT ?2 OFFSET ?3",
            )?;
            let rows = statement.query_map(params![session_id, limit, offset], |row| {
                row.get::<_, String>(0)
            })?;
            let mut events = Vec::new();
            for row in rows {
                events.push(serde_json::from_str::<ProviderEvent>(&row?)?);
            }
            Ok(EventPage { events, total })
        })
    }

    pub fn page_exchanges(
        &self,
        session_id: Uuid,
        query: &str,
        endpoint: Option<&EndpointFilter>,
        offset: u64,
        limit: u64,
    ) -> anyhow::Result<ExchangePage> {
        self.read_consistent(|connection| {
            page_exchanges(connection, session_id, query, endpoint, offset, limit)
        })
    }

    pub fn get_exchange(
        &self,
        session_id: Uuid,
        request_id: &str,
    ) -> anyhow::Result<Option<ExchangeRow>> {
        self.read_consistent(|connection| get_exchange(connection, session_id, request_id))
    }

    pub fn list_endpoints(
        &self,
        session_id: Uuid,
        query: &str,
        limit: u64,
    ) -> anyhow::Result<Vec<EndpointSummary>> {
        self.read_consistent(|connection| list_endpoints(connection, session_id, query, limit))
    }

    fn read_consistent<T>(
        &self,
        mut read: impl FnMut(&Connection) -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        let mut connection = self.connection.lock().expect("event index lock poisoned");
        loop {
            let transaction = connection.transaction()?;
            if content_states_are_clean(&transaction)? {
                let value = read(&transaction)?;
                transaction.commit()?;
                return Ok(value);
            }
            transaction.rollback()?;
            repair_dirty_content(&mut connection, &self.database_path)?;
        }
    }
}

const EXCHANGE_MATERIALIZER_REVISION: &str = "5";

fn refresh_derived_metadata(transaction: &Transaction<'_>) -> anyhow::Result<()> {
    let network_events: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM events WHERE kind IN ('network.request', 'network.response', 'network.packet')",
        [],
        |row| row.get(0),
    )?;
    let exchange_rows: i64 =
        transaction.query_row("SELECT COUNT(*) FROM exchanges", [], |row| row.get(0))?;
    for (key, value) in [
        (
            "exchange_materializer_revision",
            EXCHANGE_MATERIALIZER_REVISION.to_owned(),
        ),
        (
            "materialized_network_event_count",
            network_events.to_string(),
        ),
        ("materialized_exchange_row_count", exchange_rows.to_string()),
        ("events_content_state", "clean".to_owned()),
        ("exchanges_content_state", "clean".to_owned()),
    ] {
        transaction.execute(
            "INSERT INTO index_metadata(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
    }
    Ok(())
}

fn advance_derived_metadata(
    transaction: &Transaction<'_>,
    event: &ProviderEvent,
    exchange_existed: bool,
) -> anyhow::Result<()> {
    let is_network = matches!(
        event.kind.as_str(),
        "network.request" | "network.response" | "network.packet"
    );
    let creates_exchange = is_network
        && !exchange_existed
        && event
            .payload
            .get("request_id")
            .and_then(|value| value.as_str())
            .is_some();
    for (key, delta) in [
        ("materialized_network_event_count", i64::from(is_network)),
        (
            "materialized_exchange_row_count",
            i64::from(creates_exchange),
        ),
    ] {
        transaction.execute(
            "INSERT INTO index_metadata(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + excluded.value",
            params![key, delta],
        )?;
    }
    for (key, value) in [
        (
            "exchange_materializer_revision",
            EXCHANGE_MATERIALIZER_REVISION,
        ),
        ("events_content_state", "clean"),
        ("exchanges_content_state", "clean"),
    ] {
        transaction.execute(
            "INSERT INTO index_metadata(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
    }
    Ok(())
}

fn exchange_exists(transaction: &Transaction<'_>, event: &ProviderEvent) -> anyhow::Result<bool> {
    if event.kind != "network.request"
        && event.kind != "network.response"
        && event.kind != "network.packet"
    {
        return Ok(false);
    }
    let Some(request_id) = event
        .payload
        .get("request_id")
        .and_then(|value| value.as_str())
    else {
        return Ok(false);
    };
    Ok(transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM exchanges WHERE session_id = ?1 AND request_id = ?2)",
        params![event.session_id.to_string(), request_id],
        |row| row.get(0),
    )?)
}

fn install_integrity_triggers(connection: &Connection) -> anyhow::Result<()> {
    connection.execute_batch(
        "CREATE TRIGGER IF NOT EXISTS events_content_insert
           AFTER INSERT ON events BEGIN
             INSERT INTO index_metadata(key, value) VALUES ('events_content_state', 'dirty')
             ON CONFLICT(key) DO UPDATE SET value = 'dirty';
           END;
         CREATE TRIGGER IF NOT EXISTS events_content_update
           AFTER UPDATE ON events BEGIN
             INSERT INTO index_metadata(key, value) VALUES ('events_content_state', 'dirty')
             ON CONFLICT(key) DO UPDATE SET value = 'dirty';
           END;
         CREATE TRIGGER IF NOT EXISTS events_content_delete
           AFTER DELETE ON events BEGIN
             INSERT INTO index_metadata(key, value) VALUES ('events_content_state', 'dirty')
             ON CONFLICT(key) DO UPDATE SET value = 'dirty';
           END;
         CREATE TRIGGER IF NOT EXISTS exchanges_content_insert
           AFTER INSERT ON exchanges BEGIN
             INSERT INTO index_metadata(key, value) VALUES ('exchanges_content_state', 'dirty')
             ON CONFLICT(key) DO UPDATE SET value = 'dirty';
           END;
         CREATE TRIGGER IF NOT EXISTS exchanges_content_update
           AFTER UPDATE ON exchanges BEGIN
             INSERT INTO index_metadata(key, value) VALUES ('exchanges_content_state', 'dirty')
             ON CONFLICT(key) DO UPDATE SET value = 'dirty';
           END;
         CREATE TRIGGER IF NOT EXISTS exchanges_content_delete
           AFTER DELETE ON exchanges BEGIN
             INSERT INTO index_metadata(key, value) VALUES ('exchanges_content_state', 'dirty')
             ON CONFLICT(key) DO UPDATE SET value = 'dirty';
           END;",
    )?;
    Ok(())
}

fn insert_event_row(transaction: &Transaction<'_>, event: &ProviderEvent) -> anyhow::Result<()> {
    let event_json = serde_json::to_string(event)?;
    let evidence = serde_json::to_string(&event.evidence)?
        .trim_matches('"')
        .to_owned();
    let sequence = i64::try_from(event.sequence)
        .map_err(|_| anyhow::anyhow!("event sequence exceeds SQLite INTEGER range"))?;
    transaction.execute(
        "INSERT INTO events (
            session_id, sequence, host_time_ns, provider_id,
            evidence, kind, process_name, event_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            event.session_id.to_string(),
            sequence,
            event.host_time_ns,
            event.provider_id,
            evidence,
            event.kind,
            event.process_name,
            event_json,
        ],
    )?;
    Ok(())
}

fn ensure_exchange_columns(connection: &Connection) -> anyhow::Result<()> {
    let columns = {
        let mut statement = connection.prepare("PRAGMA table_info(exchanges)")?;
        statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<BTreeSet<_>>>()?
    };
    for (name, sql_type) in [
        ("request_evidence", "TEXT"),
        ("response_evidence", "TEXT"),
        ("request_reconstructed_state", "INTEGER"),
        ("response_reconstructed_state", "INTEGER"),
        ("request_truncated_state", "INTEGER"),
        ("response_truncated_state", "INTEGER"),
        ("request_masked_state", "INTEGER"),
        ("response_masked_state", "INTEGER"),
    ] {
        if !columns.contains(name) {
            connection.execute(
                &format!("ALTER TABLE exchanges ADD COLUMN {name} {sql_type}"),
                [],
            )?;
        }
    }
    Ok(())
}

fn authoritative_source(database: &Path) -> anyhow::Result<Option<PathBuf>> {
    let Some(database_dir) = database.parent() else {
        return Ok(None);
    };
    if database_dir.file_name().and_then(|name| name.to_str()) != Some("database") {
        return Ok(None);
    }
    let Some(session_dir) = database_dir.parent() else {
        return Ok(None);
    };
    let events_dir = session_dir.join("events");
    let metadata = match fs::symlink_metadata(&events_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    anyhow::ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "refusing symlink or non-directory event source: {}",
        events_dir.display()
    );
    let final_path = events_dir.join("provider-events.jsonl");
    if final_path.exists() {
        Ok(Some(final_path))
    } else {
        let partial_path = events_dir.join("provider-events.jsonl.partial");
        Ok(partial_path.exists().then_some(partial_path))
    }
}

fn read_no_follow(path: &Path) -> anyhow::Result<Vec<u8>> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    let metadata = file.metadata()?;
    anyhow::ensure!(
        metadata.is_file(),
        "event source is not a regular file: {}",
        path.display()
    );
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

struct AuthoritativeSnapshot {
    sha256: String,
    events: Vec<ProviderEvent>,
}

fn authoritative_snapshot(database: &Path) -> anyhow::Result<Option<AuthoritativeSnapshot>> {
    let Some(source_path) = authoritative_source(database)? else {
        return Ok(None);
    };
    let bytes = read_no_follow(&source_path)?;
    let sha256 = hex::encode(Sha256::digest(&bytes));
    let source_text = std::str::from_utf8(&bytes)?;
    let events = source_text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(serde_json::from_str::<ProviderEvent>)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(AuthoritativeSnapshot { sha256, events }))
}

fn embedded_events(connection: &Connection) -> anyhow::Result<Vec<ProviderEvent>> {
    let serialized_events = {
        let mut statement = connection.prepare(
            "SELECT event_json
             FROM events
             ORDER BY host_time_ns, provider_id, sequence",
        )?;
        statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    Ok(serialized_events
        .iter()
        .map(|serialized| serde_json::from_str::<ProviderEvent>(serialized))
        .collect::<Result<Vec<_>, _>>()?)
}

fn rebuild_events_and_exchanges(
    transaction: &Transaction<'_>,
    events: &[ProviderEvent],
) -> anyhow::Result<()> {
    transaction.execute("DELETE FROM exchanges", [])?;
    transaction.execute("DELETE FROM events", [])?;
    for event in events {
        insert_event_row(transaction, event)?;
        materialize_event(transaction, event)?;
    }
    Ok(())
}

fn rebuild_exchanges(
    transaction: &Transaction<'_>,
    events: &[ProviderEvent],
) -> anyhow::Result<()> {
    transaction.execute("DELETE FROM exchanges", [])?;
    for event in events {
        materialize_event(transaction, event)?;
    }
    Ok(())
}

fn metadata_value(connection: &Connection, key: &str) -> anyhow::Result<Option<String>> {
    Ok(connection
        .query_row(
            "SELECT value FROM index_metadata WHERE key = ?1",
            [key],
            |row| row.get::<_, String>(0),
        )
        .optional()?)
}

fn content_states_are_clean(connection: &Connection) -> anyhow::Result<bool> {
    Ok(
        metadata_value(connection, "events_content_state")?.as_deref() == Some("clean")
            && metadata_value(connection, "exchanges_content_state")?.as_deref() == Some("clean"),
    )
}

fn repair_dirty_content(connection: &mut Connection, database: &Path) -> anyhow::Result<()> {
    if content_states_are_clean(connection)? {
        Ok(())
    } else {
        repair_index(connection, database, false)
    }
}

fn derived_metadata_is_current(connection: &Connection) -> anyhow::Result<bool> {
    let network_events: i64 = connection.query_row(
        "SELECT COUNT(*) FROM events WHERE kind IN ('network.request', 'network.response', 'network.packet')",
        [],
        |row| row.get(0),
    )?;
    let exchange_rows: i64 =
        connection.query_row("SELECT COUNT(*) FROM exchanges", [], |row| row.get(0))?;
    let revision = metadata_value(connection, "exchange_materializer_revision")?;
    let materialized_network = metadata_value(connection, "materialized_network_event_count")?;
    let materialized_exchanges = metadata_value(connection, "materialized_exchange_row_count")?;
    Ok(revision.as_deref() == Some(EXCHANGE_MATERIALIZER_REVISION)
        && materialized_network.as_deref() == Some(network_events.to_string().as_str())
        && materialized_exchanges.as_deref() == Some(exchange_rows.to_string().as_str())
        && content_states_are_clean(connection)?)
}

fn repair_index(
    connection: &mut Connection,
    database: &Path,
    verify_authoritative_source: bool,
) -> anyhow::Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let events_are_dirty =
        metadata_value(&transaction, "events_content_state")?.as_deref() != Some("clean");
    let authoritative = if verify_authoritative_source || events_are_dirty {
        authoritative_snapshot(database)?
    } else {
        None
    };
    let source_requires_rebuild = if let Some(source) = authoritative.as_ref() {
        let indexed_count: i64 =
            transaction.query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))?;
        let stored_hash = metadata_value(&transaction, "authoritative_jsonl_sha256")?;
        events_are_dirty
            || stored_hash.as_deref() != Some(source.sha256.as_str())
            || u64::try_from(indexed_count)? != u64::try_from(source.events.len())?
    } else {
        false
    };
    let derived_requires_rebuild = !derived_metadata_is_current(&transaction)?;

    if source_requires_rebuild {
        let source = authoritative
            .as_ref()
            .expect("source rebuild requires an authoritative snapshot");
        rebuild_events_and_exchanges(&transaction, &source.events)?;
        transaction.execute(
            "INSERT INTO index_metadata(key, value)
             VALUES ('authoritative_jsonl_sha256', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [&source.sha256],
        )?;
        refresh_derived_metadata(&transaction)?;
    } else if events_are_dirty {
        let events = embedded_events(&transaction)?;
        rebuild_events_and_exchanges(&transaction, &events)?;
        refresh_derived_metadata(&transaction)?;
    } else if derived_requires_rebuild {
        let events = embedded_events(&transaction)?;
        rebuild_exchanges(&transaction, &events)?;
        refresh_derived_metadata(&transaction)?;
    }
    transaction.commit()?;
    Ok(())
}

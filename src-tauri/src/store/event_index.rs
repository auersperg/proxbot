use std::{path::Path, sync::Mutex};

use rusqlite::{Connection, params};
use uuid::Uuid;

use crate::domain::ProviderEvent;

use super::{
    EndpointFilter, EndpointSummary, ExchangePage,
    exchange_index::{list_endpoints, materialize_event, page_exchanges},
};

#[derive(Debug, Clone, PartialEq)]
pub struct EventPage {
    pub events: Vec<ProviderEvent>,
    pub total: u64,
}

pub struct EventIndex {
    connection: Mutex<Connection>,
}

impl EventIndex {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        let connection = Connection::open(path)?;
        connection.execute_batch(include_str!("../../migrations/0001_events.sql"))?;
        connection.execute_batch(include_str!("../../migrations/0002_exchanges.sql"))?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn insert(&self, event: &ProviderEvent) -> anyhow::Result<()> {
        let event_json = serde_json::to_string(event)?;
        let evidence = serde_json::to_string(&event.evidence)?
            .trim_matches('"')
            .to_owned();
        let mut connection = self.connection.lock().expect("event index lock poisoned");
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT INTO events (
                session_id, sequence, host_time_ns, provider_id,
                evidence, kind, process_name, event_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                event.session_id.to_string(),
                event.sequence as i64,
                event.host_time_ns,
                event.provider_id,
                evidence,
                event.kind,
                event.process_name,
                event_json,
            ],
        )?;
        materialize_event(&transaction, event)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn page(&self, session_id: Uuid, offset: u64, limit: u64) -> anyhow::Result<EventPage> {
        let connection = self.connection.lock().expect("event index lock poisoned");
        let session_id = session_id.to_string();
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
        let rows = statement
            .query_map(params![session_id, limit as i64, offset as i64], |row| {
                row.get::<_, String>(0)
            })?;
        let mut events = Vec::new();
        for row in rows {
            events.push(serde_json::from_str::<ProviderEvent>(&row?)?);
        }
        Ok(EventPage { events, total })
    }

    pub fn page_exchanges(
        &self,
        session_id: Uuid,
        query: &str,
        endpoint: Option<&EndpointFilter>,
        offset: u64,
        limit: u64,
    ) -> anyhow::Result<ExchangePage> {
        let connection = self.connection.lock().expect("event index lock poisoned");
        page_exchanges(&connection, session_id, query, endpoint, offset, limit)
    }

    pub fn list_endpoints(
        &self,
        session_id: Uuid,
        query: &str,
        limit: u64,
    ) -> anyhow::Result<Vec<EndpointSummary>> {
        let connection = self.connection.lock().expect("event index lock poisoned");
        list_endpoints(&connection, session_id, query, limit)
    }
}

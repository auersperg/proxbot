PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  host_time_ns INTEGER NOT NULL,
  provider_id TEXT NOT NULL,
  evidence TEXT NOT NULL,
  kind TEXT NOT NULL,
  process_name TEXT,
  event_json TEXT NOT NULL,
  PRIMARY KEY (session_id, provider_id, sequence)
);

CREATE INDEX IF NOT EXISTS events_timeline
  ON events (session_id, host_time_ns, provider_id, sequence);

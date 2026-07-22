CREATE TABLE IF NOT EXISTS exchanges (
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_sequence INTEGER,
  response_sequence INTEGER,
  started_ns INTEGER NOT NULL,
  method TEXT,
  scheme TEXT,
  host TEXT,
  ip TEXT,
  path TEXT,
  status INTEGER,
  protocol TEXT,
  process_name TEXT,
  duration_ms INTEGER,
  request_bytes INTEGER,
  response_bytes INTEGER,
  tls TEXT,
  evidence TEXT NOT NULL,
  warning TEXT,
  request_raw TEXT,
  response_raw TEXT,
  request_media_type TEXT,
  response_media_type TEXT,
  request_reconstructed INTEGER NOT NULL DEFAULT 0,
  response_reconstructed INTEGER NOT NULL DEFAULT 0,
  request_truncated INTEGER NOT NULL DEFAULT 0,
  response_truncated INTEGER NOT NULL DEFAULT 0,
  request_masked INTEGER NOT NULL DEFAULT 0,
  response_masked INTEGER NOT NULL DEFAULT 0,
  request_artifact_json TEXT,
  response_artifact_json TEXT,
  PRIMARY KEY (session_id, request_id)
);

CREATE INDEX IF NOT EXISTS exchanges_timeline
  ON exchanges (session_id, started_ns, request_id);
CREATE INDEX IF NOT EXISTS exchanges_domain
  ON exchanges (session_id, host, started_ns);
CREATE INDEX IF NOT EXISTS exchanges_ip
  ON exchanges (session_id, ip, started_ns);
CREATE INDEX IF NOT EXISTS exchanges_method
  ON exchanges (session_id, method, started_ns);
CREATE INDEX IF NOT EXISTS exchanges_status
  ON exchanges (session_id, status, started_ns);

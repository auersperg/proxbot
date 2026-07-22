import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SESSION_ID = "018f8a1a-82f6-7832-b4dd-db5dc6e62911";

export function createSessionFixture(root: string): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const session = join(root, SESSION_ID);
  for (const directory of [session, join(session, "database"), join(session, "exports")]) {
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  writeFileSync(
    join(session, "manifest.json"),
    `${JSON.stringify({
      schema_version: 1,
      session_id: SESSION_ID,
      status: "ready",
      event_count: 2,
    })}\n`,
    { mode: 0o600 },
  );
  const db = new Database(join(session, "database/session.sqlite"), {
    create: true,
    strict: true,
  });
  db.run(`CREATE TABLE index_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.run(
    `INSERT INTO index_metadata VALUES
      ('events_content_state','clean'),('exchanges_content_state','clean')`,
  );
  db.run(`CREATE TABLE exchanges (
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
    request_evidence TEXT,
    response_evidence TEXT,
    request_reconstructed_state INTEGER,
    response_reconstructed_state INTEGER,
    request_truncated_state INTEGER,
    response_truncated_state INTEGER,
    request_masked_state INTEGER,
    response_masked_state INTEGER,
    request_artifact_json TEXT,
    response_artifact_json TEXT,
    PRIMARY KEY(session_id,request_id)
  )`);
  db.query(
    `INSERT INTO exchanges (
      session_id,request_id,request_sequence,response_sequence,started_ns,method,scheme,host,ip,path,
      status,protocol,process_name,duration_ms,request_bytes,response_bytes,tls,evidence,warning,
      request_raw,response_raw,request_media_type,response_media_type,request_evidence,response_evidence,
      request_reconstructed_state,response_reconstructed_state,request_truncated_state,
      response_truncated_state,request_masked_state,response_masked_state
    ) VALUES ($sessionId,'req-1',1,2,1000,'POST','https','auth.example','127.0.0.1','/rpc?token=secret',
      200,'h2','Example',42,120,96,'tls1.3','observed',NULL,$requestRaw,$responseRaw,
      'application/http','application/http','observed','observed',0,0,0,0,0,0)`,
  ).run({
    sessionId: SESSION_ID,
    requestRaw:
      "POST /rpc?access_token=secret HTTP/1.1\r\nAuthorization: Bearer abc\r\nCookie: sid=abc\r\n\r\n{\"refresh_token\":\"refresh-secret\"}",
    responseRaw: "HTTP/1.1 200 OK\r\nSet-Cookie: session=abc\r\n\r\n{\"ok\":true}",
  });
  db.close();
  return session;
}

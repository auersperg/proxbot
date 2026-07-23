import { Database } from "bun:sqlite";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  EndpointFilter,
  ExchangeQuery,
  ExchangeRow,
  RawArtifactRef,
  RawView,
  SessionSummary,
} from "./contracts.ts";
import { ProxbotError } from "./errors.ts";
import { redactRaw, redactUrlMetadata } from "./redaction.ts";
import {
  assertExportParent,
  safeExportName,
  safeSessionFile,
  safeSessionPath,
  validateBoundedText,
  validateSessionId,
} from "./security.ts";

interface Manifest {
  schema_version?: unknown;
  session_id?: unknown;
  status?: unknown;
  event_count?: unknown;
}

type SqlRow = Record<string, string | number | bigint | null>;

const EXCHANGE_COLUMNS = `
  request_id AS requestId,
  request_sequence AS requestSequence,
  response_sequence AS responseSequence,
  CAST(started_ns AS TEXT) AS startedNs,
  method, scheme, host, ip, path, status, protocol,
  process_name AS processName,
  duration_ms AS durationMs,
  request_bytes AS requestBytes,
  response_bytes AS responseBytes,
  tls, evidence, warning`;

function integer(value: unknown, name: string): number | null {
  if (value === null || value === undefined) return null;
  const result = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new ProxbotError("INTEGRITY_ERROR", `Invalid ${name} in session index`);
  }
  return result;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function flag(value: unknown, name: string): boolean | null {
  if (value === null || value === undefined) return null;
  if (value === 0 || value === 0n) return false;
  if (value === 1 || value === 1n) return true;
  throw new ProxbotError("INTEGRITY_ERROR", `Invalid ${name} in session index`);
}

function parseArtifact(value: unknown): RawArtifactRef | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new ProxbotError("INTEGRITY_ERROR", "Invalid raw artifact metadata");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(value) as Record<string, unknown>;
  } catch (error) {
    throw new ProxbotError(
      "INTEGRITY_ERROR",
      "Invalid raw artifact JSON",
      {},
      { cause: error },
    );
  }
  const relativePath = parsed.relative_path;
  const offset = integer(parsed.offset, "artifact offset");
  const length = integer(parsed.length, "artifact length");
  if (typeof relativePath !== "string" || offset === null || length === null) {
    throw new ProxbotError("INTEGRITY_ERROR", "Incomplete raw artifact metadata");
  }
  return {
    relativePath,
    offset,
    length,
    sha256: typeof parsed.sha256 === "string" ? parsed.sha256 : null,
  };
}

function rawView(
  row: SqlRow,
  prefix: "request" | "response",
  maxRawBytes: number,
): RawView | null {
  const raw = text(row[`${prefix}Raw`]);
  if (raw === null) return null;
  const output = redactRaw(raw, maxRawBytes);
  return {
    content: output.content,
    mediaType: text(row[`${prefix}MediaType`]) ?? "application/octet-stream",
    evidence: text(row[`${prefix}Evidence`]) ?? "unknown",
    reconstructed: flag(row[`${prefix}Reconstructed`], `${prefix} reconstructed state`),
    truncated: flag(row[`${prefix}Truncated`], `${prefix} truncated state`),
    masked: flag(row[`${prefix}Masked`], `${prefix} masked state`),
    artifact: parseArtifact(row[`${prefix}ArtifactJson`]),
    outputTruncated: output.truncated,
    outputBytes: output.bytes,
    redactions: output.redactions,
  };
}

function exchange(row: SqlRow): ExchangeRow {
  const status = integer(row.status, "status");
  if (status !== null && (status < 100 || status > 599)) {
    throw new ProxbotError("INTEGRITY_ERROR", "Invalid HTTP status in session index");
  }
  return {
    requestId: text(row.requestId) ?? "",
    requestSequence: integer(row.requestSequence, "request sequence"),
    responseSequence: integer(row.responseSequence, "response sequence"),
    startedNs: text(row.startedNs) ?? "0",
    method: text(row.method),
    scheme: text(row.scheme),
    host: text(row.host),
    ip: text(row.ip),
    path: redactUrlMetadata(text(row.path)),
    status,
    protocol: text(row.protocol),
    processName: text(row.processName),
    durationMs: integer(row.durationMs, "duration"),
    requestBytes: integer(row.requestBytes, "request bytes"),
    responseBytes: integer(row.responseBytes, "response bytes"),
    tls: text(row.tls),
    evidence: text(row.evidence) ?? "unknown",
    warning: text(row.warning),
  };
}

function escapedLike(value: string): string {
  return `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

export class SessionRepository {
  constructor(
    private readonly sessionsRoot: string,
    private readonly maxRawBytes: number,
  ) {}

  listSessions(limit = 50): SessionSummary[] {
    const boundedLimit = Math.min(Math.max(limit, 1), 200);
    if (!existsSync(this.sessionsRoot)) return [];
    const rootMetadata = lstatSync(this.sessionsRoot);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new ProxbotError("INTEGRITY_ERROR", "Invalid sessions root");
    }
    const sessions: SessionSummary[] = [];
    for (const entry of readdirSync(this.sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      try {
        const sessionId = validateSessionId(entry.name);
        sessions.push(this.sessionSummary(sessionId));
      } catch (error) {
        if (error instanceof ProxbotError && error.code === "INVALID_ARGUMENT") continue;
        throw error;
      }
    }
    sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return sessions.slice(0, boundedLimit);
  }

  sessionSummary(sessionId: string): SessionSummary {
    const sessionRoot = safeSessionPath(this.sessionsRoot, sessionId);
    const manifestPath = safeSessionFile(sessionRoot, "manifest.json", false);
    let manifest: Manifest = {};
    if (manifestPath) {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
      } catch (error) {
        throw new ProxbotError(
          "INTEGRITY_ERROR",
          "Session manifest is invalid JSON",
          { sessionId },
          { cause: error },
        );
      }
    }
    const database = safeSessionFile(
      sessionRoot,
      "database/session.sqlite",
      false,
    );
    let exchangeCount: number | null = null;
    if (database) {
      const db = this.openDatabase(database, false);
      try {
        exchangeCount = integer(
          (db.query("SELECT COUNT(*) AS count FROM exchanges").get() as SqlRow | null)?.count,
          "exchange count",
        );
      } finally {
        db.close(false);
      }
    }
    const stats = statSync(sessionRoot);
    const status = typeof manifest.status === "string" ? manifest.status : "capturing";
    return {
      sessionId: validateSessionId(sessionId),
      status,
      eventCount: integer(manifest.event_count, "manifest event count") ?? 0,
      exchangeCount,
      createdAt: stats.birthtime.toISOString(),
      ready: status === "ready" && manifestPath !== null,
    };
  }

  listEndpoints(
    sessionId: string,
    query: string,
    limit: number,
  ): Array<{ kind: "domain" | "ip"; value: string; count: number }> {
    validateBoundedText(query, "query", 1_024);
    const boundedLimit = Math.min(Math.max(limit, 1), 2_000);
    return this.withDatabase(sessionId, (db) => {
      const output: Array<{ kind: "domain" | "ip"; value: string; count: number }> = [];
      for (const [kind, column] of [
        ["domain", "host"],
        ["ip", "ip"],
      ] as const) {
        const rows = db
          .query(
            `SELECT ${column} AS value, COUNT(*) AS count FROM exchanges
             WHERE session_id = $sessionId AND ${column} IS NOT NULL AND ${column} != ''
               AND ($like = '%%'
                 OR COALESCE(method,'') LIKE $like ESCAPE '\\'
                 OR COALESCE(host,'') LIKE $like ESCAPE '\\'
                 OR COALESCE(ip,'') LIKE $like ESCAPE '\\'
                 OR COALESCE(path,'') LIKE $like ESCAPE '\\'
                 OR COALESCE(protocol,'') LIKE $like ESCAPE '\\')
             GROUP BY ${column} ORDER BY COUNT(*) DESC, ${column} LIMIT $limit`,
          )
          .all({
            sessionId: validateSessionId(sessionId),
            like: escapedLike(query.trim()),
            limit: boundedLimit,
          }) as SqlRow[];
        for (const row of rows) {
          const value = text(row.value);
          const count = integer(row.count, "endpoint count");
          if (value !== null && count !== null) output.push({ kind, value, count });
        }
      }
      output.sort(
        (a, b) =>
          a.kind.localeCompare(b.kind) || b.count - a.count || a.value.localeCompare(b.value),
      );
      return output.slice(0, boundedLimit);
    });
  }

  queryExchanges(input: ExchangeQuery): { exchanges: ExchangeRow[]; total: number } {
    validateBoundedText(input.query, "query", 1_024);
    if (input.endpoint) {
      validateBoundedText(input.endpoint.value, "endpoint.value", 512, false);
    }
    const offset = Math.max(0, Math.min(input.offset, 10_000_000));
    const limit = Math.min(Math.max(input.limit, 1), 500);
    return this.withDatabase(input.sessionId, (db) => {
      const values: Record<string, string | number> = {
        sessionId: validateSessionId(input.sessionId),
        limit: limit,
        offset: offset,
      };
      const predicates = ["session_id = $sessionId"];
      if (input.query.trim()) {
        predicates.push(`(
          COALESCE(method,'') LIKE $like ESCAPE '\\' OR
          COALESCE(host,'') LIKE $like ESCAPE '\\' OR
          COALESCE(ip,'') LIKE $like ESCAPE '\\' OR
          COALESCE(path,'') LIKE $like ESCAPE '\\' OR
          COALESCE(protocol,'') LIKE $like ESCAPE '\\')`);
        values.like = escapedLike(input.query.trim());
      }
      if (input.endpoint) {
        const column = input.endpoint.kind === "domain" ? "host" : "ip";
        predicates.push(`${column} = $endpoint`);
        values.endpoint = input.endpoint.value;
      }
      const where = predicates.join(" AND ");
      const total = integer(
        (db
          .query(`SELECT COUNT(*) AS count FROM exchanges WHERE ${where}`)
          .get(values) as SqlRow | null)?.count,
        "exchange count",
      );
      const rows = db
        .query(
          `SELECT ${EXCHANGE_COLUMNS} FROM exchanges WHERE ${where}
           ORDER BY started_ns, request_id LIMIT $limit OFFSET $offset`,
        )
        .all(values) as SqlRow[];
      return { exchanges: rows.map(exchange), total: total ?? 0 };
    });
  }

  getExchange(sessionId: string, requestId: string, maxRawBytes?: number): ExchangeRow | null {
    validateBoundedText(requestId, "requestId", 512, false);
    const rawLimit = Math.min(
      Math.max(maxRawBytes ?? 16_384, 1_024),
      this.maxRawBytes,
    );
    return this.withDatabase(sessionId, (db) => {
      const row = db
        .query(
          `SELECT ${EXCHANGE_COLUMNS},
            request_raw AS requestRaw, response_raw AS responseRaw,
            request_media_type AS requestMediaType,
            response_media_type AS responseMediaType,
            request_evidence AS requestEvidence,
            response_evidence AS responseEvidence,
            request_reconstructed_state AS requestReconstructed,
            response_reconstructed_state AS responseReconstructed,
            request_truncated_state AS requestTruncated,
            response_truncated_state AS responseTruncated,
            request_masked_state AS requestMasked,
            response_masked_state AS responseMasked,
            request_artifact_json AS requestArtifactJson,
            response_artifact_json AS responseArtifactJson
           FROM exchanges WHERE session_id = $sessionId AND request_id = $requestId`,
        )
        .get({
          sessionId: validateSessionId(sessionId),
          requestId: requestId,
        }) as SqlRow | null;
      if (!row) return null;
      return {
        ...exchange(row),
        requestRaw: rawView(row, "request", rawLimit),
        responseRaw: rawView(row, "response", rawLimit),
      };
    });
  }

  analyze(sessionId: string): Record<string, unknown> {
    return this.withDatabase(sessionId, (db) => {
      const id = validateSessionId(sessionId);
      const top = (column: string, where: string) =>
        (db
          .query(
            `SELECT ${column} AS value, COUNT(*) AS count FROM exchanges
             WHERE session_id = $sessionId AND ${where}
             GROUP BY ${column} ORDER BY COUNT(*) DESC, ${column} LIMIT 20`,
          )
          .all({ sessionId: id }) as SqlRow[]).map((row) => ({
          value: text(row.value),
          count: integer(row.count, "analysis count"),
        }));
      const totals = db
        .query(
          `SELECT COUNT(*) AS total,
             SUM(CASE WHEN warning IS NOT NULL THEN 1 ELSE 0 END) AS warnings,
             SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
             AVG(duration_ms) AS averageDurationMs,
             MAX(duration_ms) AS maxDurationMs
           FROM exchanges WHERE session_id = $sessionId`,
        )
        .get({ sessionId: id }) as SqlRow;
      return {
        sessionId: id,
        total: integer(totals.total, "analysis total") ?? 0,
        warnings: integer(totals.warnings, "analysis warnings") ?? 0,
        errors: integer(totals.errors, "analysis errors") ?? 0,
        averageDurationMs: totals.averageDurationMs === null ? null : Number(totals.averageDurationMs),
        maxDurationMs: integer(totals.maxDurationMs, "analysis max duration"),
        topHosts: top("host", "host IS NOT NULL AND host != ''"),
        methods: top("method", "method IS NOT NULL AND method != ''"),
        statuses: top("status", "status IS NOT NULL"),
        protocols: top("protocol", "protocol IS NOT NULL AND protocol != ''"),
        warningsByType: top("warning", "warning IS NOT NULL AND warning != ''"),
      };
    });
  }

  exportExchanges(input: ExchangeQuery, exportName: string): {
    path: string;
    rows: number;
    totalMatches: number;
  } {
    const sessionRoot = safeSessionPath(this.sessionsRoot, input.sessionId);
    const exportsRoot = assertExportParent(sessionRoot);
    const name = safeExportName(exportName.endsWith(".jsonl") ? exportName : `${exportName}.jsonl`);
    const output = join(exportsRoot, name);
    const partial = `${output}.partial`;
    if (existsSync(output) || existsSync(partial)) {
      throw new ProxbotError("INVALID_ARGUMENT", `Export already exists: ${basename(output)}`);
    }
    const requestedLimit = Math.min(Math.max(input.limit, 1), 10_000);
    const pageSize = Math.min(requestedLimit, 500);
    const file = openSync(partial, "wx", 0o600);
    let rows = 0;
    let totalMatches = 0;
    try {
      while (rows < requestedLimit) {
        const page = this.queryExchanges({
          ...input,
          offset: input.offset + rows,
          limit: Math.min(pageSize, requestedLimit - rows),
        });
        totalMatches = page.total;
        if (page.exchanges.length === 0) break;
        for (const item of page.exchanges) writeSync(file, `${JSON.stringify(item)}\n`);
        rows += page.exchanges.length;
        if (rows + input.offset >= page.total) break;
      }
      fsyncSync(file);
      closeSync(file);
      renameSync(partial, output);
      const directory = openSync(exportsRoot, "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } catch (error) {
      try {
        closeSync(file);
      } catch {
        // The descriptor was already closed after a successful fsync.
      }
      if (existsSync(partial)) unlinkSync(partial);
      throw error;
    }
    return { path: output, rows, totalMatches };
  }

  private withDatabase<T>(sessionId: string, callback: (db: Database) => T): T {
    const sessionRoot = safeSessionPath(this.sessionsRoot, sessionId);
    const databasePath = safeSessionFile(sessionRoot, "database/session.sqlite");
    if (!databasePath) throw new ProxbotError("NOT_READY", "Session index is unavailable");
    const db = this.openDatabase(databasePath, true);
    try {
      return callback(db);
    } finally {
      db.close(false);
    }
  }

  private openDatabase(path: string, requireClean: boolean): Database {
    // A clean, finalized SQLite database may retain WAL journal mode while no
    // -wal/-shm sidecars exist. SQLite's ordinary read-only mode then attempts
    // to open the missing shared-memory file and fails with SQLITE_CANTOPEN.
    // Immutable mode is the correct read-only representation for that sealed
    // state. Live sessions keep their WAL sidecars and must remain ordinary
    // read-only connections so newly committed capture rows stay visible.
    let source = path;
    if (!existsSync(`${path}-wal`) && !existsSync(`${path}-shm`)) {
      const immutable = pathToFileURL(path);
      immutable.searchParams.set("immutable", "1");
      source = immutable.href;
    }
    const db = new Database(source, { readonly: true, strict: true });
    db.run("PRAGMA query_only = ON");
    db.run("PRAGMA trusted_schema = OFF");
    if (requireClean) {
      const rows = db
        .query(
          "SELECT key, value FROM index_metadata WHERE key IN ('events_content_state', 'exchanges_content_state')",
        )
        .all() as SqlRow[];
      const states = new Map(rows.map((row) => [text(row.key), text(row.value)]));
      if (states.get("events_content_state") !== "clean" || states.get("exchanges_content_state") !== "clean") {
        db.close(false);
        throw new ProxbotError(
          "NOT_READY",
          "Session index is dirty; open the session in proxbot to repair it",
        );
      }
    }
    return db;
  }
}

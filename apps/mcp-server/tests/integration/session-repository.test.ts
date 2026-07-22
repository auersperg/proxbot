import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProxbotError } from "../../src/errors.ts";
import { SessionRepository } from "../../src/session-repository.ts";
import { createSessionFixture, SESSION_ID } from "../helpers.ts";

const roots: string[] = [];
function root(): string {
  const value = mkdtempSync(join(tmpdir(), "proxbot-mcp-test-"));
  roots.push(value);
  return value;
}
afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("SessionRepository", () => {
  test("lists, queries, analyzes, redacts selected raw, and durably exports", () => {
    const sessions = join(root(), "sessions");
    const session = createSessionFixture(sessions);
    const repository = new SessionRepository(sessions, 65_536);

    expect(repository.listSessions()).toHaveLength(1);
    expect(repository.listEndpoints(SESSION_ID, "auth", 20)).toEqual([
      { kind: "domain", value: "auth.example", count: 1 },
      { kind: "ip", value: "127.0.0.1", count: 1 },
    ]);
    const page = repository.queryExchanges({
      sessionId: SESSION_ID,
      query: "POST",
      endpoint: null,
      offset: 0,
      limit: 100,
    });
    expect(page.total).toBe(1);
    expect(page.exchanges[0]?.requestRaw).toBeUndefined();
    expect(page.exchanges[0]?.path).toBe(
      "/rpc?token=<redacted-by-proxbot-mcp>",
    );
    expect(page.exchanges[0]?.path).not.toContain("secret");

    const detail = repository.getExchange(SESSION_ID, "req-1", 16_384);
    expect(detail?.path).toBe("/rpc?token=<redacted-by-proxbot-mcp>");
    expect(detail?.requestRaw?.content).not.toContain("Bearer abc");
    expect(detail?.requestRaw?.content).not.toContain("refresh-secret");
    expect(detail?.responseRaw?.content).not.toContain("session=abc");
    expect(detail?.requestRaw?.redactions).toBeGreaterThan(0);

    const analysis = repository.analyze(SESSION_ID);
    expect(analysis.total).toBe(1);
    expect(analysis.topHosts).toEqual([{ value: "auth.example", count: 1 }]);

    const exported = repository.exportExchanges(
      {
        sessionId: SESSION_ID,
        query: "",
        endpoint: null,
        offset: 0,
        limit: 10,
      },
      "agent-export",
    );
    expect(exported.rows).toBe(1);
    expect(lstatSync(exported.path).mode & 0o777).toBe(0o600);
    const exportedContent = readFileSync(exported.path, "utf8");
    expect(exportedContent).toContain('"requestId":"req-1"');
    expect(exportedContent).toContain(
      '"path":"/rpc?token=<redacted-by-proxbot-mcp>"',
    );
    expect(exportedContent).not.toContain("token=secret");
    expect(() =>
      repository.exportExchanges(
        { sessionId: SESSION_ID, query: "", endpoint: null, offset: 0, limit: 1 },
        "agent-export",
      ),
    ).toThrow();
    expect(lstatSync(join(session, "exports")).isDirectory()).toBe(true);
  });

  test("refuses a dirty index", () => {
    const sessions = join(root(), "sessions");
    const session = createSessionFixture(sessions);
    const db = new Database(join(session, "database/session.sqlite"));
    db.run("UPDATE index_metadata SET value='dirty' WHERE key='exchanges_content_state'");
    db.close();
    const repository = new SessionRepository(sessions, 65_536);
    expect(() =>
      repository.queryExchanges({
        sessionId: SESSION_ID,
        query: "",
        endpoint: null,
        offset: 0,
        limit: 1,
      }),
    ).toThrow("dirty");
  });

  test("refuses symlink session roots and traversal-shaped IDs", () => {
    const base = root();
    const realSessions = join(base, "real");
    createSessionFixture(realSessions);
    const linked = join(base, "linked");
    symlinkSync(realSessions, linked);
    const repository = new SessionRepository(linked, 65_536);
    expect(() => repository.sessionSummary(SESSION_ID)).toThrow(ProxbotError);
    expect(() => repository.sessionSummary("../../etc/passwd")).toThrow("UUID");
  });
});

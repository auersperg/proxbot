import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createSessionFixture, SESSION_ID } from "../helpers.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("proxbot MCP stdio server", () => {
  test("initializes, lists modern tools, and serves a bounded session query", async () => {
    const root = mkdtempSync(join(tmpdir(), "proxbot-mcp-stdio-"));
    roots.push(root);
    const sessions = join(root, "sessions");
    createSessionFixture(sessions);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["run", resolve(import.meta.dir, "../../src/index.ts")],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        PROXBOT_SESSIONS_ROOT: sessions,
        PROXBOT_CONTROL_SOCKET: join(root, "missing.sock"),
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "proxbot-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toContain("proxbot_health");
      expect(names).toContain("proxbot_start_capture");
      expect(names).toContain("proxbot_query_exchanges");
      expect(names).toContain("proxbot_get_exchange");
      const queryTool = listed.tools.find((tool) => tool.name === "proxbot_query_exchanges");
      expect(queryTool?.annotations?.readOnlyHint).toBe(true);
      expect(queryTool?.outputSchema).toBeDefined();

      const result = await client.callTool({
        name: "proxbot_query_exchanges",
        arguments: {
          sessionId: SESSION_ID,
          query: "auth",
          endpoint: null,
          offset: 0,
          limit: 10,
        },
      });
      expect(result.isError).not.toBe(true);
      const output = result.structuredContent as {
        ok: true;
        data: { total: number; exchanges: Array<{ requestId: string }> };
      };
      expect(output.data.total).toBe(1);
      expect(output.data.exchanges[0]?.requestId).toBe("req-1");

      const unavailable = await client.callTool({
        name: "proxbot_capture_status",
        arguments: {},
      });
      expect(unavailable.isError).toBe(true);
      expect(JSON.stringify(unavailable.content)).toContain("CONTROL_UNAVAILABLE");
    } finally {
      await client.close();
    }
  }, 15_000);
});

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UnixSocketControlAdapter } from "../../src/control.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function socketServer(
  responder: (request: Record<string, unknown>) => Record<string, unknown>,
): Promise<{ path: string; close: () => Promise<void> }> {
  const root = mkdtempSync(join(tmpdir(), "proxbot-control-test-"));
  roots.push(root);
  const path = join(root, "control.sock");
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let body = "";
    socket.on("data", (chunk) => {
      body += chunk;
      const newline = body.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(body.slice(0, newline)) as Record<string, unknown>;
      socket.end(`${JSON.stringify(responder(request))}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  chmodSync(path, 0o600);
  return {
    path,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

describe("UnixSocketControlAdapter", () => {
  test("validates the owner-only socket envelope and snapshot", async () => {
    const fixture = await socketServer((request) => ({
      version: 1,
      id: request.id,
      ok: true,
      result: {
        revision: 4,
        status: "capturing",
        sessionId: "018f8a1a-82f6-7832-b4dd-db5dc6e62911",
        sessionDir: "/tmp/session",
        profile: "deep",
        device: { id: "iphone" },
        metrics: { events: 12 },
        sources: [{ id: "pcap", label: "PCAP", status: "capturing", detail: null }],
        error: null,
      },
    }));
    try {
      const adapter = new UnixSocketControlAdapter(fixture.path, 2_000);
      expect(adapter.available).toBe(true);
      const snapshot = await adapter.startCapture({ profile: "deep", deviceId: "iphone" });
      expect(snapshot.status).toBe("capturing");
      expect(snapshot.sources[0]?.id).toBe("pcap");
    } finally {
      await fixture.close();
    }
  });

  test("rejects a mismatched response id", async () => {
    const fixture = await socketServer(() => ({
      version: 1,
      id: "wrong-id",
      ok: true,
      result: {},
    }));
    try {
      const adapter = new UnixSocketControlAdapter(fixture.path, 2_000);
      await expect(adapter.getStatus()).rejects.toThrow("envelope mismatch");
    } finally {
      await fixture.close();
    }
  });
});

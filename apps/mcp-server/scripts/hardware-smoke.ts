import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../../../", import.meta.url).pathname;
const transport = new StdioClientTransport({
  command: "/bin/sh",
  args: [`${root}scripts/proxbot-mcp`],
  cwd: root,
  env: {
    ...process.env,
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    PROXBOT_COMMAND_TIMEOUT_MS: process.env.PROXBOT_COMMAND_TIMEOUT_MS ?? "120000",
  },
  stderr: "pipe",
});
import packageInfo from "../package.json" with { type: "json" };

const client = new Client({ name: "proxbot-hardware-smoke", version: packageInfo.version });
let started = false;
let connected = false;

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    throw new Error(`${name}: ${JSON.stringify(result.content)}`);
  }
  return (result.structuredContent as { ok: true; data: Record<string, any> }).data;
}

try {
  await client.connect(transport);
  connected = true;
  const tools = await client.listTools();
  const preflight = await call("proxbot_device_preflight");
  if (!preflight.available || !preflight.paired || !preflight.trusted) {
    throw new Error("The USB iPhone must be available, paired, and trusted");
  }

  const capture = await call("proxbot_start_capture", { profile: "deep" });
  started = true;
  const requiredArtifacts = [
    join(capture.sessionDir, "capture/device.pcapng"),
    join(capture.sessionDir, "logs/device.jsonl"),
  ];
  const artifactDeadline = Date.now() + 20_000;
  while (
    requiredArtifacts.some((path) => !existsSync(path) || statSync(path).size === 0)
    && Date.now() < artifactDeadline
  ) {
    await Bun.sleep(250);
  }
  if (requiredArtifacts.some((path) => !existsSync(path) || statSync(path).size === 0)) {
    throw new Error("Live capture artifacts did not become non-empty before the smoke deadline");
  }
  await Bun.sleep(1_000);
  const marker = await call("proxbot_add_marker", { label: "MCP hardware smoke" });
  await Bun.sleep(800);
  const running = await call("proxbot_capture_status");
  const stopped = await call("proxbot_stop_capture");
  started = false;
  if (running.status !== "capturing" || stopped.status !== "ready") {
    throw new Error(`Unexpected capture states: ${running.status} -> ${stopped.status}`);
  }
  if (stopped.metrics.malformed !== 0 || stopped.metrics.dropped !== 0) {
    throw new Error("Hardware smoke observed malformed or dropped lifecycle events");
  }

  process.stdout.write(`${JSON.stringify({
    toolCount: tools.tools.length,
    device: {
      available: preflight.available,
      paired: preflight.paired,
      trusted: preflight.trusted,
      productVersion: preflight.productVersion,
    },
    capture: {
      sessionId: capture.sessionId,
      profile: capture.profile,
      runningStatus: running.status,
      finalStatus: stopped.status,
      sessionDir: stopped.sessionDir,
      metrics: stopped.metrics,
      sources: stopped.sources,
    },
    marker: { id: marker.id, label: marker.label },
  }, null, 2)}\n`);
} finally {
  if (connected) {
    try {
      const deadline = Date.now() + 125_000;
      while (Date.now() < deadline) {
        const status = await call("proxbot_capture_status");
        if (["capturing", "degraded"].includes(status.status)) {
          await call("proxbot_stop_capture");
          break;
        }
        if (status.status !== "starting" && status.status !== "stopping") break;
        await Bun.sleep(500);
      }
    } catch (error) {
      if (started) process.stderr.write(`[proxbot-hardware-smoke] cleanup failed: ${String(error)}\n`);
    }
    await client.close();
  }
}

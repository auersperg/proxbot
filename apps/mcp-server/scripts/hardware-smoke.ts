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
    join(capture.sessionDir, "proxy/request-bodies.bin"),
    join(capture.sessionDir, "proxy/response-bodies.bin"),
    join(capture.sessionDir, "proxy/websocket-messages.bin"),
  ];
  const proxySource = capture.sources?.find((source: { id?: string }) => source.id === "proxy-mitm");
  if (!proxySource?.detail || !proxySource.detail.includes("http://mitm.it")) {
    throw new Error("Deep capture did not expose its HTTP(S) proxy endpoint and CA setup URL");
  }
  const realtimeDeadline = Date.now() + 20_000;
  while (requiredArtifacts.some((path) => !existsSync(path)) && Date.now() < realtimeDeadline) {
    await Bun.sleep(250);
  }
  if (requiredArtifacts.some((path) => !existsSync(path))) {
    throw new Error("Live capture artifacts were not created before the smoke deadline");
  }

  let realtimePage: { exchanges: Array<Record<string, any>>; total: number } = {
    exchanges: [],
    total: 0,
  };
  while (realtimePage.total === 0 && Date.now() < realtimeDeadline) {
    realtimePage = (await call("proxbot_query_exchanges", {
      sessionId: capture.sessionId,
      query: "",
      endpoint: null,
      offset: 0,
      limit: 10,
    })) as typeof realtimePage;
    if (realtimePage.total === 0) await Bun.sleep(250);
  }
  if (realtimePage.total === 0 || realtimePage.exchanges.length === 0) {
    throw new Error("No realtime network exchange rows were indexed during active capture");
  }
  const firstRealtimeExchange = realtimePage.exchanges[0];
  if (!firstRealtimeExchange?.requestId || !firstRealtimeExchange?.protocol) {
    throw new Error("The realtime exchange row is missing requestId or protocol metadata");
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
  const finalizedArtifacts = requiredArtifacts.map((path) => ({
    path,
    bytes: existsSync(path) ? statSync(path).size : 0,
  }));
  if (finalizedArtifacts.slice(0, 2).some(({ bytes }) => bytes === 0)) {
    throw new Error("Finalized PCAPNG or syslog artifact is missing or empty");
  }
  if (finalizedArtifacts.slice(2).some(({ path }) => !existsSync(path))) {
    throw new Error("Finalized proxy artifact set is incomplete");
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
      indexedRealtime: {
        total: realtimePage.total,
        firstExchange: firstRealtimeExchange,
      },
      finalizedArtifacts,
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

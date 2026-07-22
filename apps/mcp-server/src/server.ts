import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ServerConfig } from "./config.ts";
import { CliControlAdapter, UnixSocketControlAdapter } from "./control.ts";
import type { ControlAdapter } from "./contracts.ts";
import { normalizeError, ProxbotError } from "./errors.ts";
import { DeviceProvider } from "./provider.ts";
import { SessionRepository } from "./session-repository.ts";
import packageInfo from "../package.json" with { type: "json" };

const SessionId = z.string().uuid().describe("proxbot capture session UUID");
const Query = z.string().max(1_024).default("");
const Endpoint = z
  .object({
    kind: z.enum(["domain", "ip"]),
    value: z.string().min(1).max(512),
  })
  .nullable()
  .default(null);
const Envelope = z.object({ ok: z.literal(true), data: z.unknown() });

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const mutating = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

function success(data: unknown) {
  const structuredContent = { ok: true as const, data };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function failure(error: unknown) {
  const normalized = normalizeError(error);
  const body = {
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      details: normalized.details,
    },
  };
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
  };
}

function guarded<Input>(callback: (input: Input) => unknown | Promise<unknown>) {
  return async (input: Input) => {
    try {
      return success(await callback(input));
    } catch (error) {
      return failure(error);
    }
  };
}

export interface ServerDependencies {
  repository?: SessionRepository;
  provider?: DeviceProvider;
  control?: ControlAdapter & { devicePreflight?: (deviceId?: string) => Promise<Record<string, unknown>> };
}

export function createProxbotServer(
  config: ServerConfig,
  dependencies: ServerDependencies = {},
): McpServer {
  const repository =
    dependencies.repository ?? new SessionRepository(config.sessionsRoot, config.maxRawBytes);
  const provider =
    dependencies.provider ?? new DeviceProvider(config.providerBinary, config.commandTimeoutMs);
  const socketControl = new UnixSocketControlAdapter(config.controlSocket, config.commandTimeoutMs);
  const control =
    dependencies.control ??
    (socketControl.available
      ? socketControl
      : config.controlBinary
        ? new CliControlAdapter(config.controlBinary, config.commandTimeoutMs)
        : socketControl);
  const deviceControl =
    dependencies.control?.devicePreflight === undefined
      ? socketControl
      : dependencies.control;

  const server = new McpServer(
    { name: "proxbot", version: packageInfo.version },
    {
      capabilities: { logging: {} },
      instructions:
        "Use bounded metadata tools before selected raw detail. Raw detail is size-capped and credential-redacted. Start/stop operations control the locally running proxbot application through its owner-only control bridge.",
    },
  );

  server.registerTool(
    "proxbot_health",
    {
      title: "Check proxbot health",
      description:
        "Report local MCP, control bridge, provider, and durable session readiness without starting capture.",
      inputSchema: z.object({}),
      outputSchema: Envelope,
      annotations: readOnly,
    },
    guarded(() => ({
      server: { name: "proxbot", version: packageInfo.version, transport: "stdio" },
      controlBridgeAvailable: control.available,
      providerAvailable: provider.available,
      latestSession: repository.listSessions(1)[0] ?? null,
    })),
  );

  server.registerTool(
    "proxbot_device_preflight",
    {
      title: "Check connected iPhone",
      description:
        "Inspect the locally connected USB iPhone, pairing, trust, and developer-mode readiness without starting capture.",
      inputSchema: z.object({ deviceId: z.string().min(1).max(256).optional() }),
      outputSchema: Envelope,
      annotations: readOnly,
    },
    guarded(async ({ deviceId }: { deviceId?: string | undefined }) => {
      if (deviceControl.available && deviceControl.devicePreflight) {
        return deviceControl.devicePreflight(deviceId);
      }
      return provider.preflight(deviceId);
    }),
  );

  server.registerTool(
    "proxbot_list_sessions",
    {
      title: "List capture sessions",
      description: "List recent local proxbot sessions with bounded status and evidence counts.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
      outputSchema: Envelope,
      annotations: readOnly,
    },
    guarded(({ limit }: { limit: number }) => ({ sessions: repository.listSessions(limit) })),
  );

  server.registerTool(
    "proxbot_session_status",
    {
      title: "Inspect session status",
      description: "Return durable readiness and indexed evidence counts for one session.",
      inputSchema: z.object({ sessionId: SessionId }),
      outputSchema: Envelope,
      annotations: readOnly,
    },
    guarded(({ sessionId }: { sessionId: string }) => repository.sessionSummary(sessionId)),
  );

  server.registerTool(
    "proxbot_capture_status",
    {
      title: "Inspect live capture",
      description: "Return the current real-time capture snapshot from the running proxbot app.",
      inputSchema: z.object({}),
      outputSchema: Envelope,
      annotations: readOnly,
    },
    guarded(() => control.getStatus()),
  );

  server.registerTool(
    "proxbot_start_capture",
    {
      title: "Start capture",
      description:
        "Start a production passive or deep capture on the selected or active USB device. Returns the authoritative capture snapshot.",
      inputSchema: z.object({
        profile: z.enum(["deep", "passive"]).default("deep"),
        deviceId: z.string().min(1).max(256).optional(),
      }),
      outputSchema: Envelope,
      annotations: mutating,
    },
    guarded((input: { profile: "deep" | "passive"; deviceId?: string | undefined }) =>
      control.startCapture({
        profile: input.profile,
        ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
      }),
    ),
  );

  server.registerTool(
    "proxbot_stop_capture",
    {
      title: "Stop and finalize capture",
      description:
        "Stop the active capture, flush authoritative evidence, finalize indexes, and return the final snapshot.",
      inputSchema: z.object({}),
      outputSchema: Envelope,
      annotations: mutating,
    },
    guarded(() => control.stopCapture()),
  );

  server.registerTool(
    "proxbot_add_marker",
    {
      title: "Add capture marker",
      description: "Append a timestamped analyst marker to the active capture session.",
      inputSchema: z.object({ label: z.string().min(1).max(256).optional() }),
      outputSchema: Envelope,
      annotations: mutating,
    },
    guarded((input: { label?: string | undefined }) =>
      control.addMarker(input.label === undefined ? {} : { label: input.label }),
    ),
  );

  server.registerTool(
    "proxbot_list_endpoints",
    {
      title: "List domains and IPs",
      description: "Return a bounded endpoint inventory for one session, ordered by evidence count.",
      inputSchema: z.object({
        sessionId: SessionId,
        query: Query,
        limit: z.number().int().min(1).max(2_000).default(200),
      }),
      outputSchema: Envelope,
      annotations: readOnly,
    },
    guarded(({ sessionId, query, limit }: { sessionId: string; query: string; limit: number }) => ({
      endpoints: repository.listEndpoints(sessionId, query, limit),
    })),
  );

  server.registerTool(
    "proxbot_query_exchanges",
    {
      title: "Query network exchanges",
      description:
        "Page bounded exchange metadata. This tool excludes raw bodies; call proxbot_get_exchange for one selected request.",
      inputSchema: z.object({
        sessionId: SessionId,
        query: Query,
        endpoint: Endpoint,
        offset: z.number().int().min(0).max(10_000_000).default(0),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      outputSchema: Envelope,
      annotations: readOnly,
    },
    guarded((input: {
      sessionId: string;
      query: string;
      endpoint: { kind: "domain" | "ip"; value: string } | null;
      offset: number;
      limit: number;
    }) => repository.queryExchanges(input)),
  );

  server.registerTool(
    "proxbot_get_exchange",
    {
      title: "Read selected raw exchange",
      description:
        "Return metadata and capped RAW request/response for one request ID. Credential-shaped values are always redacted in MCP output.",
      inputSchema: z.object({
        sessionId: SessionId,
        requestId: z.string().min(1).max(512),
        maxRawBytes: z.number().int().min(1_024).max(config.maxRawBytes).default(16_384),
      }),
      outputSchema: Envelope,
      annotations: readOnly,
    },
    guarded(({ sessionId, requestId, maxRawBytes }: {
      sessionId: string;
      requestId: string;
      maxRawBytes: number;
    }) => {
      const exchange = repository.getExchange(sessionId, requestId, maxRawBytes);
      if (!exchange) throw new ProxbotError("NOT_FOUND", `Exchange ${requestId} was not found`);
      return exchange;
    }),
  );

  server.registerTool(
    "proxbot_analyze_session",
    {
      title: "Analyze session",
      description:
        "Compute bounded aggregate counts, latency, top hosts, methods, statuses, protocols, and warnings.",
      inputSchema: z.object({ sessionId: SessionId }),
      outputSchema: Envelope,
      annotations: readOnly,
    },
    guarded(({ sessionId }: { sessionId: string }) => repository.analyze(sessionId)),
  );

  server.registerTool(
    "proxbot_export_exchanges",
    {
      title: "Export exchange metadata",
      description:
        "Atomically write a bounded JSONL metadata export inside the session exports directory. Existing files are preserved.",
      inputSchema: z.object({
        sessionId: SessionId,
        query: Query,
        endpoint: Endpoint,
        offset: z.number().int().min(0).max(10_000_000).default(0),
        limit: z.number().int().min(1).max(10_000).default(1_000),
        exportName: z.string().min(1).max(128),
      }),
      outputSchema: Envelope,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guarded((input: {
      sessionId: string;
      query: string;
      endpoint: { kind: "domain" | "ip"; value: string } | null;
      offset: number;
      limit: number;
      exportName: string;
    }) => repository.exportExchanges(input, input.exportName)),
  );

  return server;
}

import { existsSync } from "node:fs";
import { lstatSync } from "node:fs";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";

import type { CaptureMarker, CaptureSnapshot, ControlAdapter } from "./contracts.ts";
import { ProxbotError } from "./errors.ts";
import { runJsonCommand } from "./process.ts";
import { validateBoundedText } from "./security.ts";

function snapshot(value: unknown): CaptureSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProxbotError("INTEGRITY_ERROR", "Control command returned invalid JSON");
  }
  const result = value as Record<string, unknown>;
  if (
    typeof result.revision !== "number" ||
    !Number.isSafeInteger(result.revision) ||
    typeof result.status !== "string" ||
    !(result.sessionId === null || typeof result.sessionId === "string") ||
    !(result.sessionDir === null || typeof result.sessionDir === "string") ||
    typeof result.metrics !== "object" ||
    result.metrics === null ||
    !Array.isArray(result.sources) ||
    !result.sources.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>).id === "string" &&
        typeof (item as Record<string, unknown>).label === "string" &&
        typeof (item as Record<string, unknown>).status === "string" &&
        ((item as Record<string, unknown>).detail === null ||
          typeof (item as Record<string, unknown>).detail === "string"),
    ) ||
    !(result.profile === null || result.profile === "wireguard" || result.profile === "deep" || result.profile === "passive") ||
    !(result.error === null || typeof result.error === "string")
  ) {
    throw new ProxbotError("INTEGRITY_ERROR", "Control snapshot failed validation");
  }
  return result as unknown as CaptureSnapshot;
}

function marker(value: unknown): CaptureMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProxbotError("INTEGRITY_ERROR", "Control command returned invalid marker JSON");
  }
  const result = value as Record<string, unknown>;
  if (
    typeof result.id !== "string" ||
    typeof result.sessionId !== "string" ||
    typeof result.label !== "string" ||
    typeof result.createdAtMs !== "number" ||
    !Number.isSafeInteger(result.createdAtMs)
  ) {
    throw new ProxbotError("INTEGRITY_ERROR", "Control marker failed validation");
  }
  return result as unknown as CaptureMarker;
}

/**
 * Adapter for the proxbot control CLI. The binary is expected to expose the
 * same command names as Tauri (`start-capture`, `stop-capture`,
 * `capture-status`, and `add-capture-marker`) and emit one JSON snapshot.
 * No shell is involved and stdout is parsed only as JSON.
 */
export class CliControlAdapter implements ControlAdapter {
  constructor(
    private readonly binary: string | null,
    private readonly timeoutMs: number,
  ) {}

  get available(): boolean {
    return this.binary !== null && existsSync(this.binary);
  }

  async startCapture(input: {
    profile: "wireguard" | "deep" | "passive";
    deviceId?: string;
  }): Promise<CaptureSnapshot> {
    const arguments_ = ["start-capture", "--profile", input.profile, "--json"];
    if (input.deviceId !== undefined) {
      validateBoundedText(input.deviceId, "deviceId", 256, false);
      arguments_.push("--device-id", input.deviceId);
    }
    return snapshot(await this.run(arguments_));
  }

  async stopCapture(): Promise<CaptureSnapshot> {
    return snapshot(await this.run(["stop-capture", "--json"]));
  }

  async getStatus(): Promise<CaptureSnapshot> {
    return snapshot(await this.run(["capture-status", "--json"]));
  }

  async addMarker(input: { label?: string }): Promise<CaptureMarker> {
    const arguments_ = ["add-capture-marker", "--json"];
    if (input.label !== undefined) {
      validateBoundedText(input.label, "label", 256, false);
      arguments_.push("--label", input.label);
    }
    return marker(await this.run(arguments_));
  }

  private run(arguments_: string[]): Promise<unknown> {
    if (!this.binary) {
      throw new ProxbotError(
        "CONTROL_UNAVAILABLE",
        "Set PROXBOT_CONTROL_BIN to the proxbot control executable",
        { required: ["PROXBOT_CONTROL_BIN"] },
      );
    }
    return runJsonCommand(this.binary, arguments_, this.timeoutMs);
  }
}

type ControlMethod =
  | "device_preflight"
  | "start_capture"
  | "get_capture_status"
  | "stop_capture"
  | "add_capture_marker";

interface ControlResponse {
  version: 1;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code?: unknown; message?: unknown; details?: unknown };
}

export class UnixSocketControlAdapter implements ControlAdapter {
  constructor(
    readonly socketPath: string,
    private readonly timeoutMs: number,
  ) {}

  get available(): boolean {
    if (!existsSync(this.socketPath)) return false;
    const metadata = lstatSync(this.socketPath);
    return (
      metadata.isSocket() &&
      !metadata.isSymbolicLink() &&
      metadata.uid === process.getuid?.() &&
      (metadata.mode & 0o077) === 0
    );
  }

  async devicePreflight(deviceId?: string): Promise<Record<string, unknown>> {
    if (deviceId !== undefined) validateBoundedText(deviceId, "deviceId", 256, false);
    const result = await this.request("device_preflight", {
      ...(deviceId === undefined ? {} : { deviceId }),
    });
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw new ProxbotError("INTEGRITY_ERROR", "Control bridge returned invalid preflight data");
    }
    return result as Record<string, unknown>;
  }

  async startCapture(input: {
    profile: "wireguard" | "deep" | "passive";
    deviceId?: string;
  }): Promise<CaptureSnapshot> {
    if (input.deviceId !== undefined) validateBoundedText(input.deviceId, "deviceId", 256, false);
    return snapshot(
      await this.request("start_capture", {
        profile: input.profile,
        ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
      }),
    );
  }

  async stopCapture(): Promise<CaptureSnapshot> {
    return snapshot(await this.request("stop_capture", {}));
  }

  async getStatus(): Promise<CaptureSnapshot> {
    return snapshot(await this.request("get_capture_status", {}));
  }

  async addMarker(input: { label?: string }): Promise<CaptureMarker> {
    if (input.label !== undefined) validateBoundedText(input.label, "label", 256, false);
    return marker(
      await this.request("add_capture_marker", {
        ...(input.label === undefined ? {} : { label: input.label }),
      }),
    );
  }

  async request(method: ControlMethod, params: Record<string, unknown>): Promise<unknown> {
    this.assertSocket();
    const id = randomUUID();
    const wire = `${JSON.stringify({ version: 1, id, method, params })}\n`;
    if (Buffer.byteLength(wire) > 65_536) {
      throw new ProxbotError("INVALID_ARGUMENT", "Control request exceeds 64 KiB");
    }

    return await new Promise<unknown>((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath });
      let settled = false;
      let bytes = 0;
      let body = "";
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        callback();
      };
      const timer = setTimeout(
        () =>
          finish(() =>
            reject(
              new ProxbotError("TIMEOUT", "proxbot control bridge timed out", {
                timeoutMs: this.timeoutMs,
              }),
            ),
          ),
        this.timeoutMs,
      );

      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(wire));
      socket.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 65_536) {
          finish(() => reject(new ProxbotError("INTEGRITY_ERROR", "Control response exceeds 64 KiB")));
          return;
        }
        body += chunk;
      });
      socket.on("end", () => {
        if (settled) return;
        const newline = body.indexOf("\n");
        if (newline === -1) {
          finish(() => reject(new ProxbotError("INTEGRITY_ERROR", "Control response ended before a full frame")));
          return;
        }
        if (newline !== body.length - 1) {
          finish(() => reject(new ProxbotError("INTEGRITY_ERROR", "Control response contained trailing frames")));
          return;
        }
        let response: ControlResponse;
        try {
          response = JSON.parse(body.slice(0, newline)) as ControlResponse;
        } catch (error) {
          finish(() =>
            reject(
              new ProxbotError("INTEGRITY_ERROR", "Control response is invalid JSON", {}, { cause: error }),
            ),
          );
          return;
        }
        if (response.version !== 1 || response.id !== id || typeof response.ok !== "boolean") {
          finish(() => reject(new ProxbotError("INTEGRITY_ERROR", "Control response envelope mismatch")));
          return;
        }
        if (!response.ok) {
          const message =
            typeof response.error?.message === "string"
              ? response.error.message.slice(0, 4_096)
              : "proxbot control operation failed";
          finish(() =>
            reject(
              new ProxbotError("INTERNAL", message, {
                controlCode:
                  typeof response.error?.code === "string"
                    ? response.error.code.slice(0, 128)
                    : "UNKNOWN",
                ...(typeof response.error?.details === "object" && response.error.details !== null
                  ? { controlDetails: response.error.details }
                  : {}),
              }),
            ),
          );
          return;
        }
        finish(() => resolve(response.result));
      });
      socket.on("error", (error) =>
        finish(() =>
          reject(
            new ProxbotError("CONTROL_UNAVAILABLE", "proxbot control bridge is unavailable", {
              socketPath: this.socketPath,
              cause: error.message,
            }),
          ),
        ),
      );
    });
  }

  private assertSocket(): void {
    if (!existsSync(this.socketPath)) {
      throw new ProxbotError("CONTROL_UNAVAILABLE", "proxbot control socket is not available", {
        socketPath: this.socketPath,
      });
    }
    const metadata = lstatSync(this.socketPath);
    if (
      !metadata.isSocket() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new ProxbotError(
        "INTEGRITY_ERROR",
        "Control path must be an owner-only Unix socket owned by this user",
      );
    }
  }
}

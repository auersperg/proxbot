import { existsSync } from "node:fs";

import { ProxbotError } from "./errors.ts";
import { runJsonCommand } from "./process.ts";
import { validateBoundedText } from "./security.ts";

export class DeviceProvider {
  constructor(
    private readonly binary: string | null,
    private readonly timeoutMs: number,
  ) {}

  get available(): boolean {
    return this.binary !== null && existsSync(this.binary);
  }

  async preflight(deviceId?: string): Promise<Record<string, unknown>> {
    if (!this.binary) {
      throw new ProxbotError(
        "PROVIDER_UNAVAILABLE",
        "Set PROXBOT_PROVIDER_BIN to the signed proxbot iOS provider executable",
        { required: ["PROXBOT_PROVIDER_BIN"] },
      );
    }
    const arguments_ = ["device-preflight"];
    if (deviceId !== undefined) {
      validateBoundedText(deviceId, "deviceId", 256, false);
      arguments_.push("--udid", deviceId);
    }
    const result = await runJsonCommand(this.binary, arguments_, this.timeoutMs);
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw new ProxbotError("INTEGRITY_ERROR", "Provider returned an invalid preflight result");
    }
    return result as Record<string, unknown>;
  }
}

import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { ProxbotError } from "./errors.ts";

export interface ServerConfig {
  sessionsRoot: string;
  providerBinary: string | null;
  controlBinary: string | null;
  controlSocket: string;
  commandTimeoutMs: number;
  maxRawBytes: number;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ProxbotError(
      "INVALID_ARGUMENT",
      `${name} must be an integer between ${min} and ${max}`,
    );
  }
  return parsed;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const sessionsRoot = resolve(
    environment.PROXBOT_SESSIONS_ROOT ??
      join(homedir(), "Library/Application Support/com.auersperg.proxbot/sessions"),
  );
  const providerBinary = environment.PROXBOT_PROVIDER_BIN?.trim() || null;
  const controlBinary = environment.PROXBOT_CONTROL_BIN?.trim() || null;
  const controlSocket = resolve(
    environment.PROXBOT_CONTROL_SOCKET ??
      join(homedir(), "Library/Application Support/com.auersperg.proxbot/control.sock"),
  );
  return {
    sessionsRoot,
    providerBinary: providerBinary ? resolve(providerBinary) : null,
    controlBinary: controlBinary ? resolve(controlBinary) : null,
    controlSocket,
    commandTimeoutMs: boundedInteger(
      environment.PROXBOT_COMMAND_TIMEOUT_MS,
      120_000,
      1_000,
      120_000,
      "PROXBOT_COMMAND_TIMEOUT_MS",
    ),
    maxRawBytes: boundedInteger(
      environment.PROXBOT_MAX_RAW_BYTES,
      65_536,
      1_024,
      262_144,
      "PROXBOT_MAX_RAW_BYTES",
    ),
  };
}

import { describe, expect, test } from "bun:test";

import { loadConfig } from "../../src/config.ts";

describe("loadConfig", () => {
  test("uses bounded explicit configuration", () => {
    const config = loadConfig({
      HOME: "/tmp/home",
      PROXBOT_SESSIONS_ROOT: "/tmp/sessions",
      PROXBOT_CONTROL_SOCKET: "/tmp/control.sock",
      PROXBOT_COMMAND_TIMEOUT_MS: "3000",
      PROXBOT_MAX_RAW_BYTES: "8192",
    });
    expect(config.sessionsRoot).toBe("/tmp/sessions");
    expect(config.controlSocket).toBe("/tmp/control.sock");
    expect(config.commandTimeoutMs).toBe(3_000);
    expect(config.maxRawBytes).toBe(8_192);
  });

  test("rejects unbounded configuration", () => {
    expect(() => loadConfig({ PROXBOT_MAX_RAW_BYTES: "999999999" })).toThrow();
  });
});

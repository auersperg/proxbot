import type { ExchangeRow } from "./contracts";

export function fixtureExchange(overrides: Partial<ExchangeRow> = {}): ExchangeRow {
  return {
    requestId: "request-000001",
    requestSequence: 1,
    responseSequence: 2,
    startedNs: "1784730000100000000",
    method: "POST",
    scheme: "https",
    host: "auth.privy.io",
    ip: "192.0.2.10",
    path: "/api/v1/wallets/rpc",
    status: 200,
    protocol: "HTTP/2",
    processName: "FixtureApp",
    durationMs: 41,
    requestBytes: 1280,
    responseBytes: 93,
    tls: "decrypted",
    evidence: "observed",
    warning: null,
    requestRaw: {
      content: 'POST /api/v1/wallets/rpc HTTP/2\r\nHost: auth.privy.io\r\nContent-Type: application/json\r\n\r\n{"method":"signTransaction"}',
      mediaType: "application/http",
      evidence: "observed",
      reconstructed: true,
      truncated: false,
      masked: false,
      artifact: null,
    },
    responseRaw: {
      content: 'HTTP/2 200 OK\r\nContent-Type: application/json\r\nContent-Length: 46\r\n\r\n{"method":"signTransaction","status":"signed"}',
      mediaType: "application/http",
      evidence: "observed",
      reconstructed: true,
      truncated: false,
      masked: false,
      artifact: null,
    },
    ...overrides,
  };
}

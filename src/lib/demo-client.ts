import type { ApiClient } from "./api";
import type { EndpointSummary, ExchangeRow } from "./contracts";
import { fixtureExchange } from "./fixtures";

const hosts = [
  ["auth.privy.io", "192.0.2.10", "/api/v1/wallets/rpc", "POST", 200],
  ["api.mainnet-beta.solana.com", "198.51.100.20", "/", "POST", 200],
  ["api.eu.amplitude.com", "203.0.113.30", "/2/httpapi", "POST", 200],
  ["gateway.icloud.com", "192.0.2.40", ":443", "CONNECT", 200],
  ["smp-device-content.apple.com", "198.51.100.44", "/bag", "CONNECT", 200],
  ["api.onesignal.com", "203.0.113.72", "/notifications", "GET", 304],
  ["events.appsflyer.com", "192.0.2.83", "/api/v6.17/iosevent", "POST", 202],
  ["setup.icloud.com", "198.51.100.90", "/setup/ws/1/login", "POST", 401],
] as const;

const exchanges: ExchangeRow[] = Array.from({ length: 80 }, (_, index) => {
  const [host, ip, path, method, status] = hosts[index % hosts.length];
  const base = fixtureExchange({
    requestId: `browser-${String(index + 1).padStart(6, "0")}`,
    requestSequence: index * 2 + 1,
    responseSequence: index * 2 + 2,
    startedNs: (1_784_730_000_100_000_000n + BigInt(index) * 37_000_000n).toString(),
    host,
    ip,
    path,
    method,
    status,
    durationMs: 32 + (index * 17) % 240,
    requestBytes: 240 + index * 31,
    responseBytes: 93 + index * 7,
    tls: method === "CONNECT" ? "tunnel" : "decrypted",
    processName: index % 3 ? "WalletLab" : "SpringApp",
  });
  return {
    ...base,
    requestRaw: { ...base.requestRaw, content: `${method} ${path} HTTP/2\r\nHost: ${host}\r\nAccept: application/json\r\nContent-Type: application/json\r\nX-Proxbot-Request-ID: ${base.requestId}\r\n\r\n{"method":"${index % 2 ? "signTransaction" : "sendTransaction"}","sequence":${index}}` },
    responseRaw: base.responseRaw ? { ...base.responseRaw, content: `HTTP/2 ${status} ${status === 200 ? "OK" : "Observed"}\r\nContent-Type: application/json\r\nContent-Length: 42\r\nStrict-Transport-Security: max-age=31536000\r\n\r\n{"request_id":"${base.requestId}","ok":${status < 400}}` } : null,
  };
});

const endpointSummaries: EndpointSummary[] = hosts.flatMap(([host, ip], index) => [
  { kind: "domain" as const, value: host, count: 10 + index * 3 },
  { kind: "ip" as const, value: ip, count: 10 + index * 3 },
]);

export const browserDemoApi: ApiClient = {
  async createDemoSession(count) {
    return { sessionId: "browser-fixture-session", sessionDir: "/tmp/proxbot/browser-fixture-session", eventCount: Math.min(count, exchanges.length * 2 + 1) };
  },
  async pageEvents() { return { events: [], total: 0 }; },
  async fridaPreflight() { return { available: true, id: "00008140-001251C43E59001C", name: "Adam’s iPhone", type: "usb" }; },
  async listEndpoints(_sessionId, query, limit) {
    const needle = query.trim().toLowerCase();
    return endpointSummaries.filter((item) => !needle || item.value.toLowerCase().includes(needle)).slice(0, limit);
  },
  async pageExchanges(_sessionId, filter) {
    const needle = filter.query.trim().toLowerCase();
    const filtered = exchanges.filter((exchange) => {
      if (filter.endpoint) {
        const value = filter.endpoint.kind === "domain" ? exchange.host : exchange.ip;
        if (value !== filter.endpoint.value) return false;
      }
      return !needle || [exchange.method, exchange.host, exchange.ip, exchange.path, exchange.protocol, exchange.processName].some((value) => value?.toLowerCase().includes(needle));
    });
    return { exchanges: filtered.slice(filter.offset, filter.offset + filter.limit), total: filtered.length };
  },
};

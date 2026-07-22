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
    tls: method === "CONNECT" ? "tunnel" : "decrypted",
    processName: index % 3 ? "WalletLab" : "SpringApp",
  });
  const requestContent = `${method} ${path} HTTP/2\r\nHost: ${host}\r\nAccept: application/json\r\nContent-Type: application/json\r\nX-Proxbot-Request-ID: ${base.requestId}\r\n\r\n{"method":"${index % 2 ? "signTransaction" : "sendTransaction"}","sequence":${index}}`;
  const reason = status === 200 ? "OK" : status === 202 ? "Accepted" : status === 304 ? "Not Modified" : status === 401 ? "Unauthorized" : "Unknown";
  const responseBody = `{"request_id":"${base.requestId}","ok":${status < 400}}`;
  const responseLength = new TextEncoder().encode(responseBody).byteLength;
  const responseContent = `HTTP/2 ${status} ${reason}\r\nContent-Type: application/json\r\nContent-Length: ${responseLength}\r\nStrict-Transport-Security: max-age=31536000\r\n\r\n${responseBody}`;
  return {
    ...base,
    requestBytes: new TextEncoder().encode(requestContent).byteLength,
    responseBytes: new TextEncoder().encode(responseContent).byteLength,
    requestRaw: { ...base.requestRaw!, content: requestContent },
    responseRaw: base.responseRaw ? { ...base.responseRaw, content: responseContent } : null,
  };
});

function matchesQuery(exchange: ExchangeRow, query: string) {
  const needle = query.trim().toLowerCase();
  return !needle || [exchange.method, exchange.host, exchange.ip, exchange.path, exchange.protocol, exchange.processName]
    .some((value) => value?.toLowerCase().includes(needle));
}

function endpointSummaries(query: string): EndpointSummary[] {
  const matching = exchanges.filter((exchange) => matchesQuery(exchange, query));
  return hosts.flatMap(([host, ip]) => {
    const domainCount = matching.filter((exchange) => exchange.host === host).length;
    const ipCount = matching.filter((exchange) => exchange.ip === ip).length;
    return [
      ...(domainCount ? [{ kind: "domain" as const, value: host, count: domainCount }] : []),
      ...(ipCount ? [{ kind: "ip" as const, value: ip, count: ipCount }] : []),
    ];
  });
}

export const browserDemoApi: ApiClient = {
  async createDemoSession(count) {
    return { sessionId: "browser-fixture-session", sessionDir: "/tmp/proxbot/browser-fixture-session", eventCount: Math.min(count, exchanges.length * 2 + 1) };
  },
  async fridaPreflight() { return { available: true, id: "LAB-DEVICE-FIXTURE-0001", name: "Lab iPhone", type: "usb" }; },
  async listEndpoints(_sessionId, query, limit) {
    return endpointSummaries(query).slice(0, limit);
  },
  async pageExchanges(_sessionId, filter) {
    const needle = filter.query.trim().toLowerCase();
    const filtered = exchanges.filter((exchange) => {
      if (filter.endpoint) {
        const value = filter.endpoint.kind === "domain" ? exchange.host : exchange.ip;
        if (value !== filter.endpoint.value) return false;
      }
      return matchesQuery(exchange, needle);
    });
    return { exchanges: filtered.slice(filter.offset, filter.offset + filter.limit).map(withoutRaw), total: filtered.length };
  },
  async getExchange(_sessionId, requestId) {
    const exchange = exchanges.find((item) => item.requestId === requestId);
    if (!exchange) throw new Error(`Exchange ${requestId} was not found`);
    return exchange;
  },
};

function withoutRaw(exchange: ExchangeRow): ExchangeRow {
  return { ...exchange, requestRaw: null, responseRaw: null };
}

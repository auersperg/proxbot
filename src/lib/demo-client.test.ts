import { describe, expect, it } from "vitest";
import { browserDemoApi } from "./demo-client";

describe("browser demo evidence", () => {
  it("keeps page rows metadata-only and derives endpoint counts from exchanges", async () => {
    const page = await browserDemoApi.pageExchanges("browser-fixture-session", {
      query: "",
      endpoint: null,
      offset: 0,
      limit: 200,
    });
    expect(page.total).toBe(80);
    expect(page.exchanges.every((exchange) => exchange.requestRaw === null && exchange.responseRaw === null)).toBe(true);

    const endpoints = await browserDemoApi.listEndpoints("browser-fixture-session", "", 2_000);
    expect(endpoints).toHaveLength(16);
    expect(endpoints.every((endpoint) => endpoint.count === 10)).toBe(true);
  });

  it.each([
    ["browser-000001", "HTTP/2 200 OK"],
    ["browser-000006", "HTTP/2 304 Not Modified"],
    ["browser-000007", "HTTP/2 202 Accepted"],
    ["browser-000008", "HTTP/2 401 Unauthorized"],
  ])("keeps reason phrases and byte counts internally consistent for %s", async (requestId, statusLine) => {
    const exchange = await browserDemoApi.getExchange("browser-fixture-session", requestId);
    expect(exchange).not.toBeNull();
    if (!exchange) throw new Error(`Missing browser fixture ${requestId}`);
    expect(exchange.responseRaw?.content).toContain(statusLine);
    expect(exchange.requestBytes).toBe(new TextEncoder().encode(exchange.requestRaw?.content ?? "").byteLength);
    expect(exchange.responseBytes).toBe(new TextEncoder().encode(exchange.responseRaw?.content ?? "").byteLength);
    const [responseHeaders, responseBody] = exchange.responseRaw?.content.split("\r\n\r\n") ?? [];
    expect(responseHeaders).toContain(`Content-Length: ${new TextEncoder().encode(responseBody ?? "").byteLength}`);
  });

  it("uses visibly synthetic device metadata", async () => {
    await expect(browserDemoApi.fridaPreflight()).resolves.toEqual({
      available: true,
      id: "LAB-DEVICE-FIXTURE-0001",
      name: "Lab iPhone",
      type: "usb",
    });
  });

  it("uses the same global predicate for endpoint summaries and exchange pages", async () => {
    const page = await browserDemoApi.pageExchanges("browser-fixture-session", {
      query: "CONNECT",
      endpoint: null,
      offset: 0,
      limit: 200,
    });
    const endpoints = await browserDemoApi.listEndpoints("browser-fixture-session", "CONNECT", 2_000);
    expect(page.total).toBe(20);
    expect(endpoints).toHaveLength(4);
    expect(endpoints.every((endpoint) => endpoint.count === 10)).toBe(true);
    expect(endpoints.map((endpoint) => endpoint.value)).toEqual([
      "gateway.icloud.com",
      "192.0.2.40",
      "smp-device-content.apple.com",
      "198.51.100.44",
    ]);
  });
});

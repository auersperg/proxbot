import { describe, expect, it, vi } from "vitest";
import { createApi } from "./api";

describe("proxbot command client", () => {
  it("invokes the demo capture command with an explicit count", async () => {
    const invoke = vi.fn().mockResolvedValue({
      sessionId: "fixture",
      sessionDir: "/tmp/fixture",
      eventCount: 30,
    });
    const api = createApi(invoke);

    await expect(api.createDemoSession(30)).resolves.toMatchObject({
      eventCount: 30,
    });
    expect(invoke).toHaveBeenCalledWith("create_demo_session", { count: 30 });
  });

  it("requests a bounded event page", async () => {
    const invoke = vi.fn().mockResolvedValue({ events: [], total: 0 });
    const api = createApi(invoke);

    await api.pageEvents("session", 100, 200);
    expect(invoke).toHaveBeenCalledWith("page_events", {
      sessionId: "session",
      offset: 100,
      limit: 200,
    });
  });

  it("requests endpoint summaries with an explicit bound", async () => {
    const invoke = vi.fn().mockResolvedValue([]);
    const api = createApi(invoke);

    await api.listEndpoints("session", "privy", 2_000);
    expect(invoke).toHaveBeenCalledWith("list_endpoints", {
      sessionId: "session",
      query: "privy",
      limit: 2_000,
    });
  });

  it("requests a filtered exchange page without losing endpoint identity", async () => {
    const invoke = vi.fn().mockResolvedValue({ exchanges: [], total: 0 });
    const api = createApi(invoke);

    await api.pageExchanges("session", {
      query: "signTransaction",
      endpoint: { kind: "domain", value: "auth.privy.io" },
      offset: 200,
      limit: 200,
    });
    expect(invoke).toHaveBeenCalledWith("page_exchanges", {
      sessionId: "session",
      query: "signTransaction",
      endpointKind: "domain",
      endpointValue: "auth.privy.io",
      offset: 200,
      limit: 200,
    });
  });
});

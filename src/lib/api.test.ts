import { describe, expect, it, vi } from "vitest";
import { createApi } from "./api";

const snapshot = { revision: 1, status: "capturing", sessionId: "session", sessionDir: "/tmp/session" };

describe("proxbot command client", () => {
  it("maps production lifecycle operations to bounded Tauri commands", async () => {
    const invoke = vi.fn().mockResolvedValue(snapshot);
    const listen = vi.fn().mockResolvedValue(vi.fn());
    const api = createApi(invoke, listen);

    await api.startCapture({ profile: "deep", deviceId: "usb-1" });
    await api.stopCapture();
    await api.getCaptureStatus();
    await api.addMarker("before signing");
    await api.devicePreflight("usb-1");

    expect(invoke).toHaveBeenNthCalledWith(1, "start_capture", { profile: "deep", deviceId: "usb-1" });
    expect(invoke).toHaveBeenNthCalledWith(2, "stop_capture");
    expect(invoke).toHaveBeenNthCalledWith(3, "get_capture_status");
    expect(invoke).toHaveBeenNthCalledWith(4, "add_capture_marker", { label: "before signing" });
    expect(invoke).toHaveBeenNthCalledWith(5, "device_preflight", { deviceId: "usb-1" });
  });

  it("subscribes to the production capture status event", async () => {
    const listen = vi.fn().mockResolvedValue(vi.fn());
    const api = createApi(vi.fn(), listen);
    const handler = vi.fn();
    await api.subscribeCaptureStatus(handler);
    expect(listen).toHaveBeenCalledWith("capture://status", handler);
  });

  it("requests endpoint summaries with an explicit bound", async () => {
    const invoke = vi.fn().mockResolvedValue([]);
    const api = createApi(invoke, vi.fn());
    await api.listEndpoints("session", "privy", 2_000);
    expect(invoke).toHaveBeenCalledWith("list_endpoints", { sessionId: "session", query: "privy", limit: 2_000 });
  });

  it("requests a filtered exchange page without losing endpoint identity", async () => {
    const invoke = vi.fn().mockResolvedValue({ exchanges: [], total: 0 });
    const api = createApi(invoke, vi.fn());
    await api.pageExchanges("session", { query: "signTransaction", endpoint: { kind: "domain", value: "auth.privy.io" }, offset: 200, limit: 200 });
    expect(invoke).toHaveBeenCalledWith("page_exchanges", {
      sessionId: "session", query: "signTransaction", endpointKind: "domain", endpointValue: "auth.privy.io", offset: 200, limit: 200,
    });
  });

  it("requests exactly one selected exchange by immutable identity", async () => {
    const invoke = vi.fn().mockResolvedValue({ requestId: "request-42" });
    const api = createApi(invoke, vi.fn());
    await api.getExchange("session", "request-42");
    expect(invoke).toHaveBeenCalledWith("get_exchange", { sessionId: "session", requestId: "request-42" });
  });
});

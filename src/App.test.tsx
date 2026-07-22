import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import App from "./App";
import type { ApiClient } from "./lib/api";
import type { CaptureSnapshot } from "./lib/contracts";
import { fixtureExchange } from "./lib/fixtures";

const idleSnapshot = snapshot({ revision: 0, status: "idle", sessionId: null, sessionDir: null });
const liveSnapshot = snapshot({
  revision: 1,
  status: "capturing",
  sessionId: "fixture-session",
  sessionDir: "/tmp/fixture-session",
  metrics: { received: 31, persisted: 30, malformed: 1, dropped: 0, queueDepth: 1, throughputPerSecond: 42.5, driftMs: 1.2, reconnects: 0, lastEventAgeMs: 8 },
  sources: [{ id: "proxy", label: "HTTP proxy", status: "active", detail: "127.0.0.1:9090" }],
});

function snapshot(overrides: Partial<CaptureSnapshot>): CaptureSnapshot {
  return {
    revision: 0, status: "idle", sessionId: null, sessionDir: null, profile: "deep", device: null,
    metrics: { received: null, persisted: null, malformed: null, dropped: null, queueDepth: null, throughputPerSecond: null, driftMs: null, reconnects: null, lastEventAgeMs: null },
    sources: [], error: null, ...overrides,
  };
}

function client(overrides: Partial<ApiClient> = {}): ApiClient {
  const detail = fixtureExchange();
  return {
    startCapture: vi.fn().mockResolvedValue(liveSnapshot),
    stopCapture: vi.fn().mockResolvedValue(snapshot({ ...liveSnapshot, revision: 2, status: "ready" })),
    getCaptureStatus: vi.fn().mockResolvedValue(idleSnapshot),
    addMarker: vi.fn().mockResolvedValue({ id: "marker-1", sessionId: "fixture-session", createdAtMs: 1_000, label: "Marker" }),
    subscribeCaptureStatus: vi.fn().mockResolvedValue(vi.fn()),
    devicePreflight: vi.fn().mockResolvedValue({ available: true, paired: true, trusted: true, id: "fixture-device", name: "Lab iPhone", type: "usb", productVersion: "18.5" }),
    listEndpoints: vi.fn().mockResolvedValue([
      { kind: "domain", value: "auth.privy.io", count: 12 },
      { kind: "ip", value: "192.0.2.10", count: 12 },
    ]),
    pageExchanges: vi.fn().mockResolvedValue({ exchanges: [withoutRaw(detail)], total: 1 }),
    getExchange: vi.fn().mockResolvedValue(detail),
    ...overrides,
  };
}

describe("proxbot production workspace", () => {
  it("starts a live capture and renders bounded traffic, RAW panes, source and health data", async () => {
    const commandClient = client();
    render(<App client={commandClient} />);

    expect((await screen.findAllByText("Lab iPhone")).length).toBeGreaterThanOrEqual(1);
    await userEvent.click(screen.getByRole("button", { name: "Start capture" }));

    expect(await screen.findByRole("button", { name: "auth.privy.io, 12 requests" })).toBeVisible();
    expect(await screen.findByRole("button", { name: /method POST; endpoint auth\.privy\.io/ })).toBeVisible();
    expect(await screen.findByText(/HTTP\/2 200 OK/)).toBeVisible();
    expect(screen.getByRole("heading", { name: "RAW Request" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "RAW Response" })).toBeVisible();
    expect(screen.getByText("127.0.0.1:9090")).toBeVisible();
    expect(screen.getByLabelText("PERSISTED: 30")).toBeVisible();
    expect(screen.getByLabelText("THROUGHPUT: 42.5 evt/s")).toBeVisible();
    expect(commandClient.startCapture).toHaveBeenCalledWith({ profile: "deep", deviceId: "fixture-device" });
    expect(commandClient.getExchange).toHaveBeenCalledWith("fixture-session", "request-000001");
    expect(screen.queryByText(/demo/i)).not.toBeInTheDocument();
  });

  it("stops capture and adds markers through production commands", async () => {
    const commandClient = client();
    render(<App client={commandClient} />);
    await screen.findAllByText("Lab iPhone");
    await userEvent.click(screen.getByRole("button", { name: "Start capture" }));
    await screen.findByRole("button", { name: /method POST/ });

    await userEvent.click(screen.getByRole("button", { name: "Add capture marker" }));
    expect(commandClient.addMarker).toHaveBeenCalledWith(null);
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(commandClient.stopCapture).toHaveBeenCalledOnce());
    expect(await screen.findByText("ready", { selector: ".capture-status" })).toBeVisible();
  });

  it("reacts to monotonic capture status events and ignores stale snapshots", async () => {
    let listener: ((value: CaptureSnapshot) => void) | null = null;
    const commandClient = client({
      subscribeCaptureStatus: vi.fn(async (next) => { listener = next; return vi.fn(); }),
    });
    render(<App client={commandClient} />);
    await waitFor(() => expect(listener).not.toBeNull());

    await act(async () => listener?.(liveSnapshot));
    expect(await screen.findByLabelText("RECEIVED: 31")).toBeVisible();
    await act(async () => listener?.(snapshot({ ...liveSnapshot, revision: 0, metrics: { ...liveSnapshot.metrics, received: 2 } })));
    expect(screen.getByLabelText("RECEIVED: 31")).toBeVisible();
  });

  it("coalesces continuous revisions and always performs a trailing realtime refresh", async () => {
    let listener: ((value: CaptureSnapshot) => void) | null = null;
    let resolveFirstPage!: (value: { exchanges: ReturnType<typeof withoutRaw>[]; total: number }) => void;
    const firstPage = new Promise<{ exchanges: ReturnType<typeof withoutRaw>[]; total: number }>((resolve) => {
      resolveFirstPage = resolve;
    });
    const commandClient = client({
      subscribeCaptureStatus: vi.fn(async (next) => { listener = next; return vi.fn(); }),
      pageExchanges: vi.fn()
        .mockReturnValueOnce(firstPage)
        .mockResolvedValue({ exchanges: [withoutRaw(fixtureExchange())], total: 1 }),
    });
    render(<App client={commandClient} />);
    await waitFor(() => expect(listener).not.toBeNull());

    await act(async () => listener?.(liveSnapshot));
    await waitFor(() => expect(commandClient.pageExchanges).toHaveBeenCalledTimes(1), { timeout: 1_000 });
    await act(async () => {
      listener?.(snapshot({ ...liveSnapshot, revision: 2 }));
      listener?.(snapshot({ ...liveSnapshot, revision: 3 }));
      listener?.(snapshot({ ...liveSnapshot, revision: 4 }));
    });
    await new Promise((resolve) => window.setTimeout(resolve, 350));
    expect(commandClient.pageExchanges).toHaveBeenCalledTimes(1);

    resolveFirstPage({ exchanges: [withoutRaw(fixtureExchange())], total: 1 });
    await waitFor(() => expect(commandClient.pageExchanges).toHaveBeenCalledTimes(2), { timeout: 1_000 });
  });

  it("ignores a stale snapshot from a different capture session", async () => {
    let listener: ((value: CaptureSnapshot) => void) | null = null;
    const commandClient = client({
      subscribeCaptureStatus: vi.fn(async (next) => { listener = next; return vi.fn(); }),
    });
    render(<App client={commandClient} />);
    await waitFor(() => expect(listener).not.toBeNull());

    const current = snapshot({
      ...liveSnapshot,
      revision: 9,
      sessionId: "current-session",
      sessionDir: "/tmp/current-session",
      metrics: { ...liveSnapshot.metrics, received: 91 },
    });
    const stale = snapshot({
      ...liveSnapshot,
      revision: 8,
      sessionId: "previous-session",
      sessionDir: "/tmp/previous-session",
      metrics: { ...liveSnapshot.metrics, received: 8 },
    });
    await act(async () => listener?.(current));
    expect(await screen.findByLabelText("RECEIVED: 91")).toBeVisible();
    await act(async () => listener?.(stale));

    expect(screen.getByLabelText("RECEIVED: 91")).toBeVisible();
    expect(screen.queryByLabelText("RECEIVED: 8")).not.toBeInTheDocument();
  });

  it("sends exact endpoint identity back to the query boundary", async () => {
    const commandClient = client();
    render(<App client={commandClient} />);
    await screen.findAllByText("Lab iPhone");
    await userEvent.click(screen.getByRole("button", { name: "Start capture" }));
    await userEvent.click(await screen.findByRole("button", { name: "auth.privy.io, 12 requests" }));
    await waitFor(() => expect(commandClient.pageExchanges).toHaveBeenLastCalledWith("fixture-session", expect.objectContaining({ endpoint: { kind: "domain", value: "auth.privy.io" }, offset: 0, limit: 200 })));
  });

  it("keeps raw detail bounded to the newest selected request", async () => {
    let resolveFirst!: (value: ReturnType<typeof exchangeDetail>) => void;
    const firstDetail = new Promise<ReturnType<typeof exchangeDetail>>((resolve) => { resolveFirst = resolve; });
    const commandClient = client();
    vi.mocked(commandClient.pageExchanges).mockResolvedValue({ exchanges: [withoutRaw(exchangeDetail("first")), withoutRaw(exchangeDetail("second"))], total: 2 });
    vi.mocked(commandClient.getExchange).mockReturnValueOnce(firstDetail).mockResolvedValueOnce(exchangeDetail("second"));
    render(<App client={commandClient} />);
    await screen.findAllByText("Lab iPhone");
    await userEvent.click(screen.getByRole("button", { name: "Start capture" }));
    await waitFor(() => expect(commandClient.getExchange).toHaveBeenCalledWith("fixture-session", "first"));
    await userEvent.click(await screen.findByRole("button", { name: /method GET; endpoint second\.example/ }));
    expect(await screen.findByText(/X-Detail: second/)).toBeVisible();
    await act(async () => resolveFirst(exchangeDetail("first")));
    expect(screen.queryByText(/X-Detail: first/)).not.toBeInTheDocument();
  });

  it("persists keyboard-resized workspace splitters", async () => {
    window.localStorage.clear();
    const first = render(<App client={client()} />);
    const sidebar = screen.getByRole("separator", { name: "Resize endpoint sidebar" });
    sidebar.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(sidebar).toHaveAttribute("aria-valuenow", "248");
    await waitFor(() => expect(window.localStorage.getItem("proxbot.layout.sidebarWidth")).toBe("248"));
    first.unmount();
    render(<App client={client()} />);
    expect(screen.getByRole("separator", { name: "Resize endpoint sidebar" })).toHaveAttribute("aria-valuenow", "248");
  });

  it("clamps a persisted inspector split to the current compact viewport", () => {
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 680 });
    window.localStorage.setItem("proxbot.layout.inspectorHeight", "520");
    const view = render(<App client={client()} />);
    const splitter = screen.getByRole("separator", { name: "Resize raw inspector" });
    expect(splitter).toHaveAttribute("aria-valuemax", "318");
    expect(splitter).toHaveAttribute("aria-valuenow", "318");
    view.unmount();
    window.localStorage.removeItem("proxbot.layout.inspectorHeight");
    Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
  });
});

function exchangeDetail(identity: string) {
  return fixtureExchange({
    requestId: identity, method: "GET", host: `${identity}.example`, path: "/",
    requestRaw: { ...fixtureExchange().requestRaw!, content: `GET / HTTP/1.1\r\nHost: ${identity}.example\r\nX-Detail: ${identity}\r\n\r\n` },
  });
}

function withoutRaw(exchange: ReturnType<typeof fixtureExchange>) {
  return { ...exchange, requestRaw: null, responseRaw: null };
}

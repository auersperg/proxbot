import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import App from "./App";
import type { ApiClient } from "./lib/api";
import { fixtureExchange } from "./lib/fixtures";

function client(): ApiClient {
  const detail = fixtureExchange();
  return {
    createDemoSession: vi.fn().mockResolvedValue({ sessionId: "fixture-session", sessionDir: "/tmp/fixture-session", eventCount: 30 }),
    fridaPreflight: vi.fn().mockResolvedValue({ available: true, id: "fixture-device", name: "Lab iPhone", type: "usb" }),
    listEndpoints: vi.fn().mockResolvedValue([
      { kind: "domain", value: "auth.privy.io", count: 12 },
      { kind: "ip", value: "192.0.2.10", count: 12 },
    ]),
    pageExchanges: vi.fn().mockResolvedValue({ exchanges: [withoutRaw(detail)], total: 1 }),
    getExchange: vi.fn().mockResolvedValue(detail),
  };
}

describe("proxbot workspace", () => {
  it("loads endpoints, requests, and both raw panes through bounded commands", async () => {
    const commandClient = client();
    render(<App client={commandClient} />);

    await userEvent.click(screen.getByRole("button", { name: "Check iPhone" }));
    expect((await screen.findAllByText("Lab iPhone")).length).toBeGreaterThanOrEqual(1);
    await userEvent.click(screen.getByRole("button", { name: "Run verified demo" }));

    expect(await screen.findByRole("button", { name: "auth.privy.io, 12 requests" })).toBeVisible();
    expect(await screen.findByRole("button", { name: /method POST; endpoint auth\.privy\.io/ })).toBeVisible();
    expect(screen.getByRole("heading", { name: "RAW Request" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "RAW Response" })).toBeVisible();
    expect(await screen.findByText(/HTTP\/2 200 OK/)).toBeVisible();
    expect(commandClient.getExchange).toHaveBeenCalledTimes(1);
    expect(commandClient.getExchange).toHaveBeenCalledWith("fixture-session", "request-000001");
    expect(screen.getByLabelText("PERSISTED: 30")).toBeVisible();
    expect(screen.getByLabelText("DROPPED: not reported")).toBeVisible();
    expect(screen.queryByText("7 KB/s")).not.toBeInTheDocument();
    expect(screen.queryByText("42 ms")).not.toBeInTheDocument();
  });

  it("sends exact endpoint identity back to the query boundary", async () => {
    const commandClient = client();
    render(<App client={commandClient} />);
    await userEvent.click(screen.getByRole("button", { name: "Run verified demo" }));
    await userEvent.click(await screen.findByRole("button", { name: "auth.privy.io, 12 requests" }));

    await waitFor(() => expect(commandClient.pageExchanges).toHaveBeenLastCalledWith("fixture-session", expect.objectContaining({
      endpoint: { kind: "domain", value: "auth.privy.io" },
      offset: 0,
      limit: 200,
    })));
  });

  it("keeps the workspace busy until the newest endpoint request settles", async () => {
    let resolveOlder!: (value: ReturnType<typeof exchangePage>) => void;
    let resolveNewer!: (value: ReturnType<typeof exchangePage>) => void;
    const older = new Promise<ReturnType<typeof exchangePage>>((resolve) => { resolveOlder = resolve; });
    const newer = new Promise<ReturnType<typeof exchangePage>>((resolve) => { resolveNewer = resolve; });
    const commandClient = client();
    vi.mocked(commandClient.pageExchanges)
      .mockResolvedValueOnce(exchangePage("initial"))
      .mockReturnValueOnce(older)
      .mockReturnValueOnce(newer);
    render(<App client={commandClient} />);
    await userEvent.click(screen.getByRole("button", { name: "Run verified demo" }));

    await userEvent.click(await screen.findByRole("button", { name: "auth.privy.io, 12 requests" }));
    await userEvent.click(screen.getByRole("button", { name: "192.0.2.10, 12 requests" }));
    await waitFor(() => expect(commandClient.pageExchanges).toHaveBeenCalledTimes(3));

    await act(async () => { resolveOlder(exchangePage("older")); });
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();

    await act(async () => { resolveNewer(exchangePage("newer")); });
    expect(await screen.findByRole("button", { name: "Run verified demo" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /method GET; endpoint newer\.example/ })).toBeVisible();
  });

  it("ignores an error from an endpoint request superseded by a successful request", async () => {
    let rejectOlder!: (reason: Error) => void;
    let resolveNewer!: (value: ReturnType<typeof exchangePage>) => void;
    const older = new Promise<ReturnType<typeof exchangePage>>((_, reject) => { rejectOlder = reject; });
    const newer = new Promise<ReturnType<typeof exchangePage>>((resolve) => { resolveNewer = resolve; });
    const commandClient = client();
    vi.mocked(commandClient.pageExchanges)
      .mockResolvedValueOnce(exchangePage("initial"))
      .mockReturnValueOnce(older)
      .mockReturnValueOnce(newer);
    render(<App client={commandClient} />);
    await userEvent.click(screen.getByRole("button", { name: "Run verified demo" }));

    await userEvent.click(await screen.findByRole("button", { name: "auth.privy.io, 12 requests" }));
    await userEvent.click(screen.getByRole("button", { name: "192.0.2.10, 12 requests" }));
    await waitFor(() => expect(commandClient.pageExchanges).toHaveBeenCalledTimes(3));

    await act(async () => { resolveNewer(exchangePage("newer")); });
    await act(async () => { rejectOlder(new Error("stale endpoint failure")); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /method GET; endpoint newer\.example/ })).toBeVisible();
  });

  it("keeps raw detail bounded to the newest selected request", async () => {
    let resolveFirst!: (value: ReturnType<typeof exchangeDetail>) => void;
    let resolveSecond!: (value: ReturnType<typeof exchangeDetail>) => void;
    const firstDetail = new Promise<ReturnType<typeof exchangeDetail>>((resolve) => { resolveFirst = resolve; });
    const secondDetail = new Promise<ReturnType<typeof exchangeDetail>>((resolve) => { resolveSecond = resolve; });
    const commandClient = client();
    vi.mocked(commandClient.pageExchanges).mockResolvedValue({
      exchanges: [withoutRaw(exchangeDetail("first")), withoutRaw(exchangeDetail("second"))],
      total: 2,
    });
    vi.mocked(commandClient.getExchange)
      .mockReturnValueOnce(firstDetail)
      .mockReturnValueOnce(secondDetail);
    render(<App client={commandClient} />);
    await userEvent.click(screen.getByRole("button", { name: "Run verified demo" }));
    await waitFor(() => expect(commandClient.getExchange).toHaveBeenCalledWith("fixture-session", "first"));

    await userEvent.click(await screen.findByRole("button", { name: /method GET; endpoint second\.example/ }));
    await waitFor(() => expect(commandClient.getExchange).toHaveBeenCalledWith("fixture-session", "second"));
    await act(async () => { resolveSecond(exchangeDetail("second")); });
    expect(await screen.findByText(/X-Detail: second/)).toBeVisible();

    await act(async () => { resolveFirst(exchangeDetail("first")); });
    expect(screen.getByText(/X-Detail: second/)).toBeVisible();
    expect(screen.queryByText(/X-Detail: first/)).not.toBeInTheDocument();
  });

  it("keeps global busy state until overlapping preflight and query operations both settle", async () => {
    let resolvePreflight!: (value: { available: boolean; id: string; name: string; type: string }) => void;
    let resolveQuery!: (value: ReturnType<typeof exchangePage>) => void;
    const preflight = new Promise<{ available: boolean; id: string; name: string; type: string }>((resolve) => { resolvePreflight = resolve; });
    const query = new Promise<ReturnType<typeof exchangePage>>((resolve) => { resolveQuery = resolve; });
    const commandClient = client();
    vi.mocked(commandClient.fridaPreflight).mockReturnValueOnce(preflight);
    vi.mocked(commandClient.pageExchanges)
      .mockResolvedValueOnce(exchangePage("initial"))
      .mockReturnValueOnce(query);
    render(<App client={commandClient} />);
    await userEvent.click(screen.getByRole("button", { name: "Run verified demo" }));
    await screen.findByRole("button", { name: /method GET; endpoint initial\.example/ });

    await userEvent.click(screen.getByRole("button", { name: "Check iPhone" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Filter requests" }), "POST");
    await waitFor(() => expect(commandClient.pageExchanges).toHaveBeenCalledTimes(2));
    await act(async () => resolvePreflight({ available: true, id: "fixture", name: "Lab iPhone", type: "usb" }));
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();

    await act(async () => resolveQuery(exchangePage("query")));
    expect(await screen.findByRole("button", { name: "Run verified demo" })).toBeEnabled();
  });

  it("persists keyboard-resized workspace splitters", async () => {
    window.localStorage.clear();
    const first = render(<App client={client()} />);
    const sidebar = screen.getByRole("separator", { name: "Resize endpoint sidebar" });
    expect(sidebar).toHaveAttribute("aria-valuenow", "232");
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
    expect(splitter.parentElement).toHaveStyle("--inspector-height: 318px");

    view.unmount();
    window.localStorage.removeItem("proxbot.layout.inspectorHeight");
    Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
  });

  it("does not let an older preflight success erase a newer query failure", async () => {
    let resolvePreflight!: (value: { available: boolean; id: string; name: string; type: string }) => void;
    let rejectQuery!: (reason: Error) => void;
    const preflight = new Promise<{ available: boolean; id: string; name: string; type: string }>((resolve) => { resolvePreflight = resolve; });
    const query = new Promise<ReturnType<typeof exchangePage>>((_, reject) => { rejectQuery = reject; });
    const commandClient = client();
    vi.mocked(commandClient.fridaPreflight).mockReturnValueOnce(preflight);
    vi.mocked(commandClient.pageExchanges)
      .mockResolvedValueOnce(exchangePage("initial"))
      .mockReturnValueOnce(query);
    render(<App client={commandClient} />);
    await userEvent.click(screen.getByRole("button", { name: "Run verified demo" }));
    await screen.findByRole("button", { name: /method GET; endpoint initial\.example/ });

    await userEvent.click(screen.getByRole("button", { name: "Check iPhone" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Filter requests" }), "failed-query");
    await waitFor(() => expect(commandClient.pageExchanges).toHaveBeenCalledTimes(2));
    await act(async () => rejectQuery(new Error("query failed after preflight started")));
    expect(await screen.findByRole("alert")).toHaveTextContent("query failed after preflight started");

    await act(async () => resolvePreflight({ available: true, id: "fixture", name: "Lab iPhone", type: "usb" }));
    expect(screen.getByRole("alert")).toHaveTextContent("query failed after preflight started");
  });
});

function exchangePage(identity: string) {
  return {
    exchanges: [withoutRaw(fixtureExchange({
      requestId: identity,
      method: "GET",
      host: `${identity}.example`,
      path: "/",
    }))],
    total: 1,
  };
}

function exchangeDetail(identity: string) {
  return fixtureExchange({
    requestId: identity,
    method: "GET",
    host: `${identity}.example`,
    path: "/",
    requestRaw: {
      ...fixtureExchange().requestRaw!,
      content: `GET / HTTP/1.1\r\nHost: ${identity}.example\r\nX-Detail: ${identity}\r\n\r\n`,
    },
  });
}

function withoutRaw(exchange: ReturnType<typeof fixtureExchange>) {
  return { ...exchange, requestRaw: null, responseRaw: null };
}

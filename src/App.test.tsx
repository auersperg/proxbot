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
    pageEvents: vi.fn().mockResolvedValue({ events: [], total: 0 }),
    fridaPreflight: vi.fn().mockResolvedValue({ available: true, id: "fixture-device", name: "Adam’s iPhone", type: "usb" }),
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
    expect((await screen.findAllByText("Adam’s iPhone")).length).toBeGreaterThanOrEqual(1);
    await userEvent.click(screen.getByRole("button", { name: "Run verified demo" }));

    expect(await screen.findByRole("button", { name: "auth.privy.io, 12 requests" })).toBeVisible();
    expect(await screen.findByRole("button", { name: /POST auth\.privy\.io/ })).toBeVisible();
    expect(screen.getByRole("heading", { name: "RAW Request" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "RAW Response" })).toBeVisible();
    expect(screen.getByText(/HTTP\/2 200 OK/)).toBeVisible();
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
    expect(screen.getByRole("button", { name: /GET newer\.example/ })).toBeVisible();
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
    expect(screen.getByRole("button", { name: /GET newer\.example/ })).toBeVisible();
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

    await userEvent.click(await screen.findByRole("button", { name: /GET second\.example/ }));
    await waitFor(() => expect(commandClient.getExchange).toHaveBeenCalledWith("fixture-session", "second"));
    await act(async () => { resolveSecond(exchangeDetail("second")); });
    expect(await screen.findByText(/X-Detail: second/)).toBeVisible();

    await act(async () => { resolveFirst(exchangeDetail("first")); });
    expect(screen.getByText(/X-Detail: second/)).toBeVisible();
    expect(screen.queryByText(/X-Detail: first/)).not.toBeInTheDocument();
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

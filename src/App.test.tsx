import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import App from "./App";
import type { ApiClient } from "./lib/api";
import { fixtureExchange } from "./lib/fixtures";

function client(): ApiClient {
  return {
    createDemoSession: vi.fn().mockResolvedValue({ sessionId: "fixture-session", sessionDir: "/tmp/fixture-session", eventCount: 30 }),
    pageEvents: vi.fn().mockResolvedValue({ events: [], total: 0 }),
    fridaPreflight: vi.fn().mockResolvedValue({ available: true, id: "fixture-device", name: "Adam’s iPhone", type: "usb" }),
    listEndpoints: vi.fn().mockResolvedValue([
      { kind: "domain", value: "auth.privy.io", count: 12 },
      { kind: "ip", value: "192.0.2.10", count: 12 },
    ]),
    pageExchanges: vi.fn().mockResolvedValue({ exchanges: [fixtureExchange()], total: 1 }),
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
});

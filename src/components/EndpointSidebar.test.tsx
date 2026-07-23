import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import EndpointSidebar from "./EndpointSidebar";

const endpoints = [
  { kind: "domain" as const, value: "auth.privy.io", count: 12 },
  { kind: "ip" as const, value: "192.0.2.10", count: 7 },
];
const sources = [
  { id: "proxy-mitm", label: "HTTP proxy", status: "active" as const, detail: "192.168.1.31:9090" },
  { id: "tls", label: "TLS plaintext", status: "idle" as const, detail: "not configured" },
];

describe("EndpointSidebar", () => {
  it("separates domain and IP identities and emits exact filters", async () => {
    const onSelect = vi.fn();
    render(<EndpointSidebar device={{ name: "Lab iPhone", id: "fixture-device", available: true }} endpoints={endpoints} total={12} selected={null} sources={sources} onSelect={onSelect} />);
    expect(screen.getByRole("heading", { name: "Domains" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "IP addresses" })).toBeVisible();
    expect(screen.getAllByText("12")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /Lab iPhone.*12/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Lab iPhone.*19/ })).not.toBeInTheDocument();
    expect(screen.getByText("192.168.1.31:9090")).toBeVisible();
    expect(screen.getByText("not configured")).toBeVisible();
    expect(screen.getByText("http://mitm.it")).toBeVisible();
    expect(screen.queryByText("ready")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /auth\.privy\.io/ }));
    expect(onSelect).toHaveBeenCalledWith({ kind: "domain", value: "auth.privy.io" });
  });

  it("explains manual HTTPS setup without claiming CA trust or pinning bypass", async () => {
    render(<EndpointSidebar device={{ name: "Lab iPhone", id: "fixture-device", available: true }} endpoints={endpoints} total={19} selected={null} sources={sources} onSelect={vi.fn()} />);

    expect(screen.getByLabelText("HTTP proxy: active")).toBeVisible();
    expect(screen.queryByText(/Listening does not prove CA trust/)).not.toBeVisible();
    await userEvent.click(screen.getByText("CA setup"));
    expect(screen.getByText("Route not observed")).toBeVisible();
    expect(screen.getByText("HTTPS unresolved")).toBeVisible();
    expect(screen.getByText("Hooks unavailable")).toBeVisible();
    expect(screen.getByText(/Set the iPhone Wi-Fi proxy/)).toBeVisible();
    expect(screen.getByText(/Listening does not prove CA trust/)).toBeVisible();
    expect(screen.getByText(/Certificate-pinned apps may remain encrypted/)).toBeVisible();
  });

  it("shows observed proxy routing separately from unresolved HTTPS trust", async () => {
    const routedSources = [{
      ...sources[0]!,
      detail: "192.168.1.31:9090 · client traffic observed",
    }];
    render(<EndpointSidebar device={{ name: "Lab iPhone", id: "fixture-device", available: true }} endpoints={endpoints} total={19} selected={null} sources={routedSources} onSelect={vi.fn()} />);

    await userEvent.click(screen.getByText("CA setup"));
    expect(screen.getByText("Route observed")).toBeVisible();
    expect(screen.getByText("HTTPS unresolved")).toBeVisible();
    expect(screen.queryByText("HTTPS observed")).not.toBeInTheDocument();
  });

  it("renders a scannable WireGuard profile without exposing the private key as text", async () => {
    const wireguardSources = [{
      id: "proxy-mitm",
      label: "WireGuard HTTP(S) inspection",
      status: "active" as const,
      detail: "192.168.1.23:51820 · WireGuard full tunnel · profile /private/proxbot.conf · CA http://mitm.it",
    }];
    render(
      <EndpointSidebar
        device={{ name: "Lab iPhone", id: "fixture-device", available: true }}
        endpoints={endpoints}
        total={19}
        selected={null}
        sources={wireguardSources}
        wireguardSetup={{
          clientConfig: "[Interface]\nPrivateKey = fixture\n\n[Peer]\nEndpoint = 192.168.1.23:51820\n",
          clientConfigPath: "/private/proxbot.conf",
        }}
        onSelect={vi.fn()}
      />,
    );

    expect(await screen.findByRole("img", { name: "WireGuard client configuration QR code" })).toHaveAttribute("src", expect.stringMatching(/^data:image\/svg\+xml/));
    expect(screen.getByText(/add a tunnel by scanning this QR code/)).toBeVisible();
    expect(screen.getByText("/private/proxbot.conf")).toBeVisible();
    expect(screen.queryByText(/PrivateKey = fixture/)).not.toBeInTheDocument();
  });

  it("keeps a large endpoint inventory bounded in the DOM", () => {
    const manyEndpoints = Array.from({ length: 2_000 }, (_, index) => ({
      kind: "domain" as const,
      value: `host-${index}.example.test`,
      count: index + 1,
    }));
    const { container } = render(
      <EndpointSidebar
        device={{ name: "Lab iPhone", id: "fixture-device", available: true }}
        endpoints={manyEndpoints}
        total={2_001_000}
        selected={null}
        sources={sources}
        onSelect={vi.fn()}
      />,
    );
    const mountedRows = container.querySelectorAll(".endpoint-row");
    expect(mountedRows.length).toBeGreaterThan(0);
    expect(mountedRows.length).toBeLessThan(100);
    expect(container.querySelectorAll(".endpoint-tree-item, .endpoint-tree-heading").length).toBeLessThan(100);
    expect(screen.queryByRole("button", { name: /host-1999\.example\.test/ })).not.toBeInTheDocument();
  });

  it("moves keyboard focus between endpoint kinds and activates the focused endpoint", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <EndpointSidebar
        device={{ name: "Lab iPhone", id: "fixture-device", available: true }}
        endpoints={endpoints}
        total={19}
        selected={null}
        sources={sources}
        onSelect={onSelect}
      />,
    );

    const domain = screen.getByRole("button", { name: /auth\.privy\.io/ });
    const ip = screen.getByRole("button", { name: /192\.0\.2\.10/ });
    domain.focus();

    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(ip).toHaveFocus());
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith({ kind: "ip", value: "192.0.2.10" });

    await user.keyboard("{Home}");
    await waitFor(() => expect(domain).toHaveFocus());
    await user.keyboard(" ");
    expect(onSelect).toHaveBeenLastCalledWith({ kind: "domain", value: "auth.privy.io" });
  });

});

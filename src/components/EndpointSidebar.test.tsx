import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import EndpointSidebar from "./EndpointSidebar";

const endpoints = [
  { kind: "domain" as const, value: "auth.privy.io", count: 12 },
  { kind: "ip" as const, value: "192.0.2.10", count: 7 },
];

describe("EndpointSidebar", () => {
  it("separates domain and IP identities and emits exact filters", async () => {
    const onSelect = vi.fn();
    render(<EndpointSidebar device={{ name: "Lab iPhone", id: "fixture-device", available: true }} endpoints={endpoints} total={12} selected={null} onSelect={onSelect} />);
    expect(screen.getByRole("heading", { name: "Domains" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "IP addresses" })).toBeVisible();
    expect(screen.getAllByText("12")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /Lab iPhone.*12/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Lab iPhone.*19/ })).not.toBeInTheDocument();
    expect(screen.getAllByText("not reported")).toHaveLength(3);
    expect(screen.getByText("not configured")).toBeVisible();
    expect(screen.queryByText("ready")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /auth\.privy\.io/ }));
    expect(onSelect).toHaveBeenCalledWith({ kind: "domain", value: "auth.privy.io" });
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

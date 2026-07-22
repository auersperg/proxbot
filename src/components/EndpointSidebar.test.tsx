import { render, screen } from "@testing-library/react";
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
    render(<EndpointSidebar device={{ name: "Adam’s iPhone", id: "fixture-device", available: true }} endpoints={endpoints} selected={null} onSelect={onSelect} />);
    expect(screen.getByRole("heading", { name: "Domains" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "IP addresses" })).toBeVisible();
    expect(screen.getByText("12")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /auth\.privy\.io/ }));
    expect(onSelect).toHaveBeenCalledWith({ kind: "domain", value: "auth.privy.io" });
  });
});

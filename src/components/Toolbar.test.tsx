import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import Toolbar from "./Toolbar";

const callbacks = () => ({
  onQuery: vi.fn(), onProfile: vi.fn(), onStart: vi.fn(), onStop: vi.fn(), onRefresh: vi.fn(), onMarker: vi.fn(),
});

describe("Toolbar", () => {
  it("exposes only production capture controls while idle", async () => {
    const actions = callbacks();
    render(<Toolbar busy={false} status="idle" device={{ available: true, paired: true, trusted: true, id: "usb-1", name: "iPhone", productVersion: "18.5" }} profile="deep" query="" {...actions} />);

    await userEvent.click(screen.getByRole("button", { name: "Start capture" }));
    await userEvent.click(screen.getByRole("button", { name: "Refresh capture" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Filter requests" }), "privy");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Capture profile" }), "passive");

    expect(actions.onStart).toHaveBeenCalledOnce();
    expect(actions.onRefresh).toHaveBeenCalledOnce();
    expect(actions.onQuery).toHaveBeenLastCalledWith("privy");
    expect(actions.onProfile).toHaveBeenCalledWith("passive");
    expect(screen.getByRole("option", { name: "VPN + USB" })).toHaveValue("wireguard");
    expect(screen.getByRole("option", { name: "HTTP proxy + USB" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "USB packets only" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Capture profile" })).toHaveAttribute("aria-description", expect.stringContaining("Certificate pinning is reported, not bypassed"));
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add capture marker" })).toBeDisabled();
    expect(screen.queryByText(/demo/i)).not.toBeInTheDocument();
  });

  it("enables stop and marker only for an active capture", async () => {
    const actions = callbacks();
    render(<Toolbar busy={false} status="capturing" device={{ available: true, paired: true, trusted: true, id: "usb-1", name: "iPhone", productVersion: "18.5" }} profile="deep" query="" {...actions} />);

    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await userEvent.click(screen.getByRole("button", { name: "Add capture marker" }));
    expect(actions.onStop).toHaveBeenCalledOnce();
    expect(actions.onMarker).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Start capture" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Capture profile" })).toBeDisabled();
  });

  it("keeps stop available when an active device disconnects", async () => {
    const actions = callbacks();
    render(<Toolbar busy={false} status="capturing" device={{ available: false, paired: false, trusted: false, error: "disconnected" }} profile="deep" query="" {...actions} />);
    expect(screen.getByRole("button", { name: "Start capture" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(actions.onStop).toHaveBeenCalledOnce();
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import Toolbar from "./Toolbar";

describe("Toolbar", () => {
  it("exposes device, capture state, filtering, and actions", async () => {
    const onPreflight = vi.fn();
    const onStart = vi.fn();
    const onFilter = vi.fn();
    render(<Toolbar busy={false} status="ready" device={null} query="" onQuery={onFilter} onPreflight={onPreflight} onStart={onStart} />);
    await userEvent.click(screen.getByRole("button", { name: "Check iPhone" }));
    await userEvent.click(screen.getByRole("button", { name: "Run verified demo" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Filter requests" }), "privy");
    expect(onPreflight).toHaveBeenCalledOnce();
    expect(onStart).toHaveBeenCalledOnce();
    expect(onFilter).toHaveBeenLastCalledWith("privy");
    expect(screen.getByRole("button", { name: "Pause capture" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add marker" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add marker" })).toHaveAttribute("title", "Markers require an active capture provider");
    expect(screen.getByRole("combobox", { name: "Capture profile" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Capture profile" })).toHaveAttribute("title", "Capture profiles require an active capture provider");
  });
});

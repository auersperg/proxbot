import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { fixtureExchange } from "../lib/fixtures";
import RequestTable from "./RequestTable";

describe("RequestTable", () => {
  it("renders diagnostic columns and selects by immutable request identity", async () => {
    const onSelect = vi.fn();
    const exchange = fixtureExchange();
    render(<RequestTable exchanges={[exchange]} total={1} offset={0} limit={200} selectedId={null} busy={false} onSelect={onSelect} onPage={() => {}} />);
    for (const heading of ["Method", "Host / IP", "Status", "Protocol", "Duration", "Request", "Response", "TLS"]) {
      expect(screen.getByText(heading)).toBeVisible();
    }
    const row = screen.getByRole("button", { name: /POST auth\.privy\.io/ });
    await userEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith("request-000001");
  });

  it("shows a missing response explicitly", () => {
    const exchange = fixtureExchange({ status: null, responseRaw: null, warning: "response_missing" });
    render(<RequestTable exchanges={[exchange]} total={1} offset={0} limit={200} selectedId={exchange.requestId} busy={false} onSelect={() => {}} onPage={() => {}} />);
    expect(screen.getByText("Response missing")).toBeVisible();
  });
});

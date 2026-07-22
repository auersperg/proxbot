import { render, screen, waitFor } from "@testing-library/react";
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
    const exchange = fixtureExchange({ status: 504, responseRaw: null, warning: "response_missing", evidence: "enriched" });
    render(<RequestTable exchanges={[exchange]} total={1} offset={0} limit={200} selectedId={exchange.requestId} busy={false} onSelect={() => {}} onPage={() => {}} />);
    expect(screen.getByText("Response missing")).toBeVisible();
    expect(screen.getByText("504")).toBeVisible();
    expect(screen.getByText("ENRICHED")).toBeVisible();
  });

  it("keeps the header and virtualized rows in one horizontal scroll surface", () => {
    const exchange = fixtureExchange();
    render(<RequestTable exchanges={[exchange]} total={1} offset={0} limit={200} selectedId={exchange.requestId} busy={false} onSelect={() => {}} onPage={() => {}} />);
    const header = screen.getByRole("columnheader", { name: "Method" }).parentElement;
    const row = screen.getByRole("button", { name: /POST auth\.privy\.io/ });
    expect(header?.parentElement).toBe(row.closest(".request-scroll"));
  });

  it("moves selection and focus with the diagnostic arrow-key workflow", async () => {
    const onSelect = vi.fn();
    const exchanges = ["first", "second", "third"].map((requestId) => fixtureExchange({
      requestId,
      host: `${requestId}.example`,
    }));
    render(<RequestTable exchanges={exchanges} total={3} offset={0} limit={200} selectedId="second" busy={false} onSelect={onSelect} onPage={() => {}} />);
    const selected = screen.getByRole("button", { name: /POST second\.example/ });
    selected.focus();

    await userEvent.keyboard("{ArrowDown}");

    expect(onSelect).toHaveBeenCalledWith("third");
    await waitFor(() => expect(screen.getByRole("button", { name: /POST third\.example/ })).toHaveFocus());
  });
});

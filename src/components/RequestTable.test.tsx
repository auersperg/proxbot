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
    const row = screen.getByRole("button", { name: /method POST; endpoint auth\.privy\.io/ });
    await userEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith("request-000001");
  });

  it("shows a missing response explicitly", () => {
    const exchange = fixtureExchange({ status: 504, responseRaw: null, warning: "response_missing", evidence: "enriched" });
    render(<RequestTable exchanges={[exchange]} total={1} offset={0} limit={200} selectedId={exchange.requestId} busy={false} onSelect={() => {}} onPage={() => {}} />);
    const warning = screen.getByText("Response missing");
    expect(warning).toBeVisible();
    expect(warning).toHaveAttribute("title", "Response missing");
    expect(screen.getByText("504")).toBeVisible();
    expect(screen.getByText("ENRICHED")).toBeVisible();
    expect(screen.getByRole("button", { name: /status 504; warning Response missing;.*evidence enriched/ })).toBeVisible();
  });

  it("keeps observed IP and process attribution visible together", () => {
    const exchange = fixtureExchange({ host: "back.x.place", ip: "104.21.83.177", processId: 97956, processName: "Runner" });
    render(<RequestTable exchanges={[exchange]} total={1} offset={0} limit={200} selectedId={exchange.requestId} busy={false} onSelect={() => {}} onPage={() => {}} />);
    expect(screen.getByText("104.21.83.177 · Runner")).toBeVisible();
  });

  it("keeps the header and virtualized rows in one horizontal scroll surface", () => {
    const exchange = fixtureExchange();
    render(<RequestTable exchanges={[exchange]} total={1} offset={0} limit={200} selectedId={exchange.requestId} busy={false} onSelect={() => {}} onPage={() => {}} />);
    const header = screen.getByText("Method").parentElement;
    const row = screen.getByRole("button", { name: /method POST; endpoint auth\.privy\.io/ });
    expect(header?.parentElement).toBe(row.closest(".request-scroll"));
    expect(screen.queryByRole("columnheader")).not.toBeInTheDocument();
  });

  it("moves selection and focus with the diagnostic arrow-key workflow", async () => {
    const onSelect = vi.fn();
    const exchanges = ["first", "second", "third"].map((requestId) => fixtureExchange({
      requestId,
      host: `${requestId}.example`,
    }));
    render(<RequestTable exchanges={exchanges} total={3} offset={0} limit={200} selectedId="second" busy={false} onSelect={onSelect} onPage={() => {}} />);
    const selected = screen.getByRole("button", { name: /method POST; endpoint second\.example/ });
    selected.focus();

    await userEvent.keyboard("{ArrowDown}");

    expect(onSelect).toHaveBeenCalledWith("third");
    await waitFor(() => expect(screen.getByRole("button", { name: /method POST; endpoint third\.example/ })).toHaveFocus());
  });

  it("distinguishes process plaintext from proxy decryption and USB packet metadata", () => {
    const exchanges = [
      fixtureExchange({
        requestId: "process",
        captureLayer: "process",
        plaintextState: "observed",
        providerId: "ios-process-observer",
        processName: "WalletApp",
        processId: 731,
        correlationId: "task-73",
      }),
      fixtureExchange({ requestId: "proxy" }),
      fixtureExchange({
        requestId: "usb",
        captureLayer: "usb",
        plaintextState: "not_observed",
        providerId: "ios-live",
        tls: null,
      }),
    ];

    render(<RequestTable exchanges={exchanges} total={3} offset={0} limit={200} selectedId={null} busy={false} onSelect={() => {}} onPage={() => {}} />);

    expect(screen.getByText("PLAINTEXT OBSERVED IN PROCESS")).toBeVisible();
    expect(screen.getByText("PLAINTEXT DECRYPTED BY PROXY")).toBeVisible();
    expect(screen.getByText("USB PACKET · APP PLAINTEXT NOT OBSERVED")).toBeVisible();
    expect(screen.getByRole("button", { name: /capture PLAINTEXT OBSERVED IN PROCESS; provider ios-process-observer; process WalletApp; correlation task-73/ })).toBeVisible();
  });
});

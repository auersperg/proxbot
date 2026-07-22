import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import Timeline from "./Timeline.svelte";
import type { ProviderEvent } from "$lib/contracts";

const event: ProviderEvent = {
  schemaVersion: 1,
  providerId: "fake",
  providerVersion: "0.1.0",
  sessionId: "fixture",
  sequence: 4,
  sourceTimeNs: "1",
  hostTimeNs: "2",
  monotonicTimeNs: "3",
  deviceId: "fixture-device",
  processId: 42,
  processName: "FixtureApp",
  evidence: "observed",
  kind: "network.request",
  payload: { fixture: true },
  rawRef: null,
  parseStatus: "parsed",
};

describe("Timeline", () => {
  it("shows evidence, process, kind, and sequence", () => {
    render(Timeline, {
      props: { events: [event], selectedSequence: null, onSelect: () => {} },
    });
    expect(screen.getByText("OBSERVED")).toBeTruthy();
    expect(screen.getByText("FixtureApp")).toBeTruthy();
    expect(screen.getByText("network.request")).toBeTruthy();
    expect(screen.getByText("#4")).toBeTruthy();
  });

  it("selects a row with pointer or keyboard activation", async () => {
    const onSelect = vi.fn();
    render(Timeline, {
      props: { events: [event], selectedSequence: null, onSelect },
    });
    const row = screen.getByRole("button", { name: /network.request/ });
    await fireEvent.click(row);
    await fireEvent.keyDown(row, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenLastCalledWith(event);
  });
});

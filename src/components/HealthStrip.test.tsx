import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HealthStrip from "./HealthStrip";

describe("HealthStrip", () => {
  it("keeps every loss and throughput dimension visible", () => {
    render(<HealthStrip status="degraded" received={101} persisted={100} malformed={1} dropped={2} queueDepth={4} throughput="7 KB/s" drift="0.4 ms" reconnects={1} lastEventAge="42 ms" sessionPath="/tmp/session" />);
    for (const value of ["DEGRADED", "101", "100", "1", "2", "4", "7 KB/s", "0.4 ms", "42 ms"]) {
      expect(screen.getByText(value)).toBeVisible();
    }
    expect(screen.getByTitle("/tmp/session")).toBeVisible();
  });
});

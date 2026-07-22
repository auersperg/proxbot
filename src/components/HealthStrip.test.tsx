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

  it("labels unavailable health evidence instead of presenting synthetic zeroes", () => {
    render(<HealthStrip status="ready" received={null} persisted={30} malformed={null} dropped={null} queueDepth={null} throughput={null} drift={null} reconnects={null} lastEventAge={null} sessionPath="/tmp/session" />);
    expect(screen.getByLabelText("PERSISTED: 30")).toBeVisible();
    for (const label of ["RECEIVED", "MALFORMED", "DROPPED", "QUEUE", "THROUGHPUT", "DRIFT", "RECONNECTS", "LAST EVENT"]) {
      expect(screen.getByLabelText(`${label}: not reported`)).toBeVisible();
    }
  });
});

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fixtureExchange } from "../lib/fixtures";
import RawInspector from "./RawInspector";

describe("RawInspector", () => {
  it("shows request and response simultaneously with provenance", () => {
    render(<RawInspector exchange={fixtureExchange()} />);
    expect(screen.getByRole("heading", { name: "RAW Request" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "RAW Response" })).toBeVisible();
    expect(screen.getByText(/POST \/api\/v1\/wallets\/rpc HTTP\/2/)).toBeVisible();
    expect(screen.getByText(/HTTP\/2 200 OK/)).toBeVisible();
    expect(screen.getAllByText("Reconstructed")).toHaveLength(2);
    expect(screen.getAllByText("application/http")).toHaveLength(2);
  });

  it("does not synthesize an absent response", () => {
    render(<RawInspector exchange={fixtureExchange({ responseRaw: null, status: null })} />);
    expect(screen.getByText("No response was observed for this request.")).toBeVisible();
  });
});

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
    expect(screen.getAllByText("EVIDENCE OBSERVED")).toHaveLength(2);
    expect(screen.getAllByText("Complete")).toHaveLength(2);
    expect(screen.getAllByText("Unmasked")).toHaveLength(2);
    expect(screen.getAllByText("Raw")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Headers" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Body" })).not.toBeInTheDocument();
  });

  it("states every raw transformation flag even when the view is original", () => {
    const exchange = fixtureExchange({
      requestRaw: {
        content: "AAEC",
        mediaType: "application/octet-stream; encoding=base64",
        evidence: "enriched",
        reconstructed: false,
        truncated: true,
        masked: true,
        artifact: { relativePath: "objects/sha256/a1", offset: 19, length: 3, sha256: "a1" },
      },
    });
    render(<RawInspector exchange={exchange} />);
    const pane = screen.getByRole("region", { name: "RAW Request" });
    expect(pane).toHaveTextContent("Original");
    expect(pane).toHaveTextContent("Truncated");
    expect(pane).toHaveTextContent("Masked");
    expect(pane).toHaveTextContent("offset 19 · 3 B · a1");
    expect(pane).toHaveTextContent("EVIDENCE ENRICHED");
  });

  it("keeps pane-specific evidence and unknown transformation metadata explicit", () => {
    const exchange = fixtureExchange({
      evidence: "inferred",
      requestRaw: { ...fixtureExchange().requestRaw!, evidence: "observed" },
      responseRaw: {
        ...fixtureExchange().responseRaw!,
        evidence: "inferred",
        reconstructed: null,
        truncated: null,
        masked: null,
      },
    });
    render(<RawInspector exchange={exchange} />);
    const request = screen.getByRole("region", { name: "RAW Request" });
    const response = screen.getByRole("region", { name: "RAW Response" });
    expect(request).toHaveTextContent("EVIDENCE OBSERVED");
    expect(response).toHaveTextContent("EVIDENCE INFERRED");
    expect(response).toHaveTextContent("Origin unknown");
    expect(response).toHaveTextContent("Completeness unknown");
    expect(response).toHaveTextContent("Masking unknown");
  });

  it("does not synthesize an absent response", () => {
    render(<RawInspector exchange={fixtureExchange({ responseSequence: null, responseRaw: null, status: null, warning: "response_missing" })} />);
    expect(screen.getByText("No response was observed for this request.")).toBeVisible();
  });

  it("distinguishes an observed response without supplied raw evidence", () => {
    render(<RawInspector exchange={fixtureExchange({ responseRaw: null })} />);
    expect(screen.getByText("No raw response evidence was supplied for this exchange.")).toBeVisible();
    expect(screen.queryByText("No response was observed for this request.")).not.toBeInTheDocument();
  });

  it("does not present the response-only placeholder as an empty raw request", () => {
    render(<RawInspector exchange={fixtureExchange({
      requestSequence: null,
      warning: "request_missing",
      requestRaw: null,
    })} />);
    expect(screen.getByText("No request was observed for this response.")).toBeVisible();
  });

  it("recognizes request-missing inside a composed warning", () => {
    render(<RawInspector exchange={fixtureExchange({
      requestSequence: null,
      warning: "request_missing;invalid_status",
      requestRaw: null,
    })} />);
    expect(screen.getByText("No request was observed for this response.")).toBeVisible();
  });

  it("distinguishes selected detail without supplied raw request evidence from no selection", () => {
    render(<RawInspector exchange={fixtureExchange({ requestRaw: null })} />);
    expect(screen.getByText("No raw request evidence was supplied for this exchange.")).toBeVisible();
    expect(screen.queryByText("Select a request to inspect its exact raw evidence.")).not.toBeInTheDocument();
  });
});

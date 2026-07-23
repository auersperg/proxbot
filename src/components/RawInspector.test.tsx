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
    expect(screen.getAllByText("PLAINTEXT DECRYPTED BY PROXY")).toHaveLength(2);
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

  it("renders an opaque octet-stream body as exact hex instead of mojibake", () => {
    const exchange = fixtureExchange({
      requestRaw: {
        content: "POST /events HTTP/2\r\ncontent-type: application/octet-stream\r\n\r\n\u001eXO\u0093\u007f\u00e8\u0000A",
        mediaType: "application/octet-stream",
        evidence: "observed",
        reconstructed: true,
        truncated: false,
        masked: false,
        artifact: { relativePath: "proxy/request-bodies.bin", offset: 0, length: 8, sha256: "a".repeat(64) },
      },
    });

    render(<RawInspector exchange={exchange} />);

    const pane = screen.getByRole("region", { name: "RAW Request" });
    expect(pane).toHaveTextContent("Header + Body Hex");
    expect(pane).toHaveTextContent("Binary application body rendered byte-for-byte");
    expect(pane).toHaveTextContent("TLS plaintext was recovered");
    expect(pane).toHaveTextContent(/00000000\s+1e 58 4f 93 7f e8 00 41/);
    expect(pane).not.toHaveTextContent("\u001eXO\u0093\u007f\u00e8\u0000A");
  });

  it("labels a decoded gzip analyst view while retaining wire-artifact provenance", () => {
    const exchange = fixtureExchange({
      responseRaw: {
        content: "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-encoding: gzip\r\n\r\n{\"balance\":\"12.34\"}",
        mediaType: "application/json; content-decoded=gzip",
        evidence: "observed",
        reconstructed: true,
        truncated: false,
        masked: false,
        artifact: {
          relativePath: "proxy/response-bodies.bin",
          offset: 4096,
          length: 41,
          sha256: "b".repeat(64),
        },
      },
    });

    render(<RawInspector exchange={exchange} />);

    const pane = screen.getByRole("region", { name: "RAW Response" });
    expect(pane).toHaveTextContent("Decoded gzip");
    expect(pane).toHaveTextContent("Analyst view decoded from gzip content encoding");
    expect(pane).toHaveTextContent("original content-encoded wire body remains byte-for-byte");
    expect(pane).toHaveTextContent("{\"balance\":\"12.34\"}");
    expect(pane).toHaveTextContent("offset 4096 · 41 B");
    expect(pane).not.toHaveTextContent("Header + Body Hex");
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

  it("presents packet evidence as exact hex plus ASCII with packet analysis", () => {
    const exchange = fixtureExchange({
      method: "OUT",
      scheme: null,
      host: "api.example.test",
      ip: "192.0.2.44",
      path: "192.168.1.30:55102 → 192.0.2.44:443",
      status: null,
      protocol: "TCP",
      providerId: "ios-live",
      captureLayer: "usb",
      plaintextState: "not_observed",
      correlationId: null,
      hostSource: "tls.sni",
      processId: 731,
      tls: "observed",
      requestBytes: 66,
      responseSequence: null,
      responseRaw: null,
      warning: "packet_metadata",
      requestRaw: {
        content: "00000000  45 00 00 42                                      |E..B|\n00000004\n",
        mediaType: "application/vnd.proxbot.packet+hexdump; charset=utf-8",
        evidence: "observed",
        reconstructed: false,
        truncated: false,
        masked: false,
        artifact: {
          relativePath: "capture/device.pcapng",
          offset: 256,
          length: 66,
          sha256: "a".repeat(64),
        },
      },
    });

    render(<RawInspector exchange={exchange} />);

    expect(screen.getByRole("heading", { name: "RAW Packet" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Packet Analysis" })).toBeVisible();
    expect(screen.getByText("Hex + ASCII")).toBeVisible();
    expect(screen.getByText(/00000000\s+45 00 00 42/)).toBeVisible();
    expect(screen.getByText("api.example.test")).toBeVisible();
    expect(screen.getByText("192.168.1.30:55102 → 192.0.2.44:443")).toBeVisible();
    expect(screen.getByText("capture/device.pcapng @ 256 + 66 B")).toBeVisible();
    expect(screen.getByText(/TLS application data remains encrypted/)).toBeVisible();
    expect(screen.getAllByText("USB PACKET · APP PLAINTEXT NOT OBSERVED").length).toBeGreaterThan(0);
    expect(screen.getByText("Direct route observed")).toBeVisible();
    expect(screen.getByText("CA / pinning not assessed")).toBeVisible();
    expect(screen.getByText("In-process visibility unavailable")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "RAW Response" })).not.toBeInTheDocument();
  });

  it("does not equate CONNECT with CA trust or HTTPS plaintext", () => {
    render(<RawInspector exchange={fixtureExchange({
      method: "CONNECT",
      scheme: "",
      path: "/",
      tls: "cleartext",
      plaintextState: "not_observed",
      requestRaw: null,
      responseRaw: null,
    })} sources={[{ id: "proxy-mitm", label: "HTTP(S) proxy", status: "active", detail: "192.168.1.23:9091 · client traffic observed" }]} />);

    expect(screen.getByText("Proxy route observed")).toBeVisible();
    const https = screen.getByText("HTTPS trust unresolved");
    expect(https).toBeVisible();
    expect(https).toHaveAttribute("title", expect.stringContaining("cannot be distinguished"));
    expect(screen.queryByText("HTTPS plaintext observed")).not.toBeInTheDocument();
  });

  it("labels actual intercepted HTTP as observed plaintext without claiming pinning bypass", () => {
    render(<RawInspector exchange={fixtureExchange({ tls: "intercepted", plaintextState: "observed" })} sources={[{ id: "proxy-mitm", label: "HTTP(S) proxy", status: "active", detail: "192.168.1.23:9091 · HTTPS plaintext observed" }]} />);

    const state = screen.getByText("HTTPS plaintext observed");
    expect(state).toBeVisible();
    expect(state).toHaveAttribute("title", expect.stringContaining("does not imply certificate-pinning bypass"));
  });

  it("does not mislabel a packet without an artifact as an HTTP request or response", () => {
    render(<RawInspector exchange={fixtureExchange({
      method: "PACKET",
      providerId: "ios-live",
      captureLayer: "usb",
      plaintextState: "not_observed",
      warning: "packet_metadata",
      requestRaw: null,
      responseRaw: null,
      responseSequence: null,
    })} />);

    expect(screen.getByText("No exact captured packet bytes were supplied for this record.")).toBeVisible();
    expect(screen.getByText("No exact artifact range supplied")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "RAW Request" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "RAW Response" })).not.toBeInTheDocument();
  });

  it("labels true in-process plaintext and exposes host process provider and correlation provenance", () => {
    render(<RawInspector exchange={fixtureExchange({
      providerId: "ios-process-observer",
      captureLayer: "process",
      plaintextState: "observed",
      correlationId: "urlsession-task-73",
      hostSource: "process.url",
      processId: 731,
      processName: "WalletApp",
      host: "auth.example.test",
      tls: "encrypted on wire; plaintext observed before encryption",
    })} />);

    expect(screen.getAllByText("PLAINTEXT OBSERVED IN PROCESS")).toHaveLength(2);
    expect(screen.getAllByText("HOST auth.example.test")).toHaveLength(2);
    expect(screen.getAllByText("PROCESS WalletApp (PID 731)")).toHaveLength(2);
    expect(screen.getAllByText("PROVIDER ios-process-observer")).toHaveLength(2);
    expect(screen.getAllByText("HOST SOURCE process.url")).toHaveLength(2);
    expect(screen.getAllByText("CORRELATION urlsession-task-73")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "RAW Request" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "RAW Response" })).toBeVisible();
    expect(screen.queryByText("PLAINTEXT DECRYPTED BY PROXY")).not.toBeInTheDocument();
  });
});

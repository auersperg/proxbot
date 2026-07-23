import { describe, expect, it } from "vitest";
import { formatBytes, formatObservedTime, plaintextEvidenceLabel, responseLabel, warningLabel } from "./exchange";

describe("exchange presentation helpers", () => {
  it("formats nanosecond timestamps without Number precision loss", () => {
    expect(formatObservedTime("1784730000100000000")).toBe("14:20:00.100");
  });

  it("keeps absent responses distinct and formats compact diagnostics", () => {
    expect(responseLabel(null)).toBe("—");
    expect(responseLabel(0)).toBe("0");
    expect(formatBytes(1280)).toBe("1.25 KB");
    expect(warningLabel("response_missing")).toBe("Response missing");
    expect(warningLabel("request_missing;invalid_status")).toBe("Request missing; Invalid status");
  });

  it("never conflates process observation, proxy decryption, and USB packet evidence", () => {
    expect(plaintextEvidenceLabel({ captureLayer: "process", plaintextState: "observed" })).toBe("PLAINTEXT OBSERVED IN PROCESS");
    expect(plaintextEvidenceLabel({ captureLayer: "proxy", plaintextState: "decrypted" })).toBe("PLAINTEXT DECRYPTED BY PROXY");
    expect(plaintextEvidenceLabel({ captureLayer: "usb", plaintextState: "not_observed" })).toBe("USB PACKET · APP PLAINTEXT NOT OBSERVED");
    expect(plaintextEvidenceLabel({ captureLayer: "process", plaintextState: "unknown" })).toBe("PROCESS EVIDENCE · PLAINTEXT UNVERIFIED");
  });
});

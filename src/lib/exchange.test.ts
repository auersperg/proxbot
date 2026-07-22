import { describe, expect, it } from "vitest";
import { formatBytes, formatObservedTime, responseLabel, warningLabel } from "./exchange";

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
});

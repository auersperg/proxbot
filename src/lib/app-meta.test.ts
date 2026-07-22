import { describe, expect, it } from "vitest";
import { APP_META } from "./app-meta";

describe("APP_META", () => {
  it("uses the stable proxbot desktop identity", () => {
    expect(APP_META).toEqual({
      name: "proxbot",
      bundleIdentifier: "com.auersperg.proxbot",
    });
  });
});

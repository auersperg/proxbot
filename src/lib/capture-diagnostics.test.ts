import { describe, expect, it } from "vitest";
import { fixtureExchange } from "./fixtures";
import { diagnoseCapturePath, proxyRuntimeState } from "./capture-diagnostics";

const proxyListening = [{
  id: "proxy-mitm",
  label: "HTTP(S) proxy",
  status: "active" as const,
  detail: "192.168.1.23:9091 · iPhone Wi-Fi proxy · CA http://mitm.it · client traffic observed",
}];

describe("capture path diagnostics", () => {
  it("classifies an attributed public TLS packet as observed direct routing without inferring pinning", () => {
    const result = diagnoseCapturePath(fixtureExchange({
      method: "OUT",
      path: "192.168.1.30:49764 → 104.21.83.177:443",
      host: "back.x.place",
      ip: "104.21.83.177",
      processName: "Runner",
      providerId: "ios-live",
      captureLayer: "usb",
      plaintextState: "not_observed",
      warning: "packet_metadata",
      scheme: null,
      tls: null,
    }), proxyListening);

    expect(result.route).toBe("direct_observed");
    expect(result.https).toBe("not_applicable");
    expect(result.processLabel).toBe("Process Runner observed");
    expect(result.httpsDetail).toContain("does not test whether the proxy CA is trusted");
    expect(result.inProcessLabel).toBe("In-process visibility unavailable");
  });

  it("keeps CONNECT distinct from accepted HTTPS plaintext", () => {
    const result = diagnoseCapturePath(fixtureExchange({
      method: "CONNECT",
      captureLayer: "proxy",
      plaintextState: "not_observed",
      scheme: "",
      tls: "cleartext",
      requestRaw: null,
    }), proxyListening);

    expect(result.route).toBe("proxy_observed");
    expect(result.https).toBe("connect_only");
    expect(result.httpsDetail).toContain("CA trust, certificate pinning, and client closure cannot be distinguished");
  });

  it("recognizes a USB packet to the configured proxy without treating it as accepted HTTPS", () => {
    const result = diagnoseCapturePath(fixtureExchange({
      method: "OUT",
      providerId: "ios-live",
      captureLayer: "usb",
      plaintextState: "not_observed",
      path: "192.168.1.30:62117 → 192.168.1.23:9091",
      ip: "192.168.1.23",
      warning: "packet_metadata",
    }), proxyListening);

    expect(result.route).toBe("proxy_observed");
    expect(result.routeDetail).toContain("targets the configured proxy endpoint");
    expect(result.https).toBe("unresolved");
  });

  it("recognizes actual proxy HTTPS plaintext without claiming a bypass", () => {
    const result = diagnoseCapturePath(fixtureExchange({ tls: "intercepted", plaintextState: "observed" }), proxyListening);
    expect(result.https).toBe("plaintext_observed");
    expect(result.httpsDetail).toContain("does not imply certificate-pinning bypass");
  });

  it("derives only explicit runtime milestones from source detail", () => {
    expect(proxyRuntimeState(proxyListening)).toMatchObject({
      available: true,
      listening: true,
      routeObserved: true,
      httpsPlaintextObserved: false,
      inProcessAvailable: false,
    });
    expect(proxyRuntimeState([{ ...proxyListening[0]!, detail: `${proxyListening[0]!.detail} · HTTPS plaintext observed` }]).httpsPlaintextObserved).toBe(true);
  });
});

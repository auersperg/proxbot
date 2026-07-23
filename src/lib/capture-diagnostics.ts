import type { EvidenceSource, ExchangeRow } from "./contracts";

export type RouteDiagnostic = "direct_observed" | "proxy_observed" | "route_unresolved";
export type HttpsDiagnostic = "plaintext_observed" | "connect_only" | "not_applicable" | "unresolved";

export interface CapturePathDiagnostic {
  route: RouteDiagnostic;
  routeLabel: string;
  routeDetail: string;
  https: HttpsDiagnostic;
  httpsLabel: string;
  httpsDetail: string;
  processLabel: string;
  inProcessLabel: string;
  inProcessDetail: string;
}

function sourceIdentity(source: EvidenceSource) {
  return `${source.id} ${source.label}`.toLowerCase();
}

function proxySource(sources: EvidenceSource[]) {
  return sources.find((source) => {
    const identity = sourceIdentity(source);
    return identity.includes("proxy") && (identity.includes("http") || identity.includes("mitm"));
  });
}

function configuredProxyEndpoint(sources: EvidenceSource[]) {
  const detail = proxySource(sources)?.detail ?? "";
  return detail.match(/(?:^|[\s·])((?:\d{1,3}\.){3}\d{1,3}:\d{1,5})(?:[\s·]|$)/)?.[1] ?? null;
}

function hasInProcessSource(sources: EvidenceSource[]) {
  return sources.some((source) => {
    const identity = sourceIdentity(source);
    return source.status === "active" && ["instrument", "frida", "in-process", "application plaintext"].some((token) => identity.includes(token));
  });
}

function warningContains(exchange: ExchangeRow, warning: string) {
  return exchange.warning?.split(";").includes(warning) === true;
}

export function proxyRuntimeState(sources: EvidenceSource[]) {
  const proxy = proxySource(sources);
  const detail = proxy?.detail ?? "";
  return {
    available: proxy !== undefined,
    listening: proxy?.status === "active",
    routeObserved: detail.includes("client traffic observed") || detail.includes("HTTPS plaintext observed"),
    httpsPlaintextObserved: detail.includes("HTTPS plaintext observed"),
    inProcessAvailable: hasInProcessSource(sources),
  };
}

export function diagnoseCapturePath(exchange: ExchangeRow, sources: EvidenceSource[]): CapturePathDiagnostic {
  const packet = warningContains(exchange, "packet_metadata");
  const connect = exchange.method?.toUpperCase() === "CONNECT";
  const proxyEndpoint = configuredProxyEndpoint(sources);
  const packetToProxy = packet && proxyEndpoint !== null && exchange.path?.includes(proxyEndpoint) === true;
  const proxyPlaintext = !connect
    && exchange.captureLayer === "proxy"
    && exchange.scheme === "https"
    && (exchange.plaintextState === "observed" || exchange.plaintextState === "decrypted");
  const processLabel = exchange.processName ? `Process ${exchange.processName} observed` : "Process not attributed";
  const inProcess = exchange.captureLayer === "process" || hasInProcessSource(sources);

  const route: RouteDiagnostic = exchange.captureLayer === "proxy" || connect || proxyPlaintext || packetToProxy
    ? "proxy_observed"
    : exchange.captureLayer === "usb" && packet && exchange.path !== null
      ? "direct_observed"
      : "route_unresolved";
  const routeLabel = route === "proxy_observed" ? "Proxy route observed"
    : route === "direct_observed" ? "Direct route observed"
      : "Route unresolved";
  const routeDetail = route === "proxy_observed"
    ? packetToProxy
      ? `The captured iPhone packet targets the configured proxy endpoint ${proxyEndpoint}; this does not establish CA trust.`
      : connect
        ? "The proxy observed a CONNECT instruction for this flow."
        : "The proxy observed this application HTTP(S) exchange."
    : route === "direct_observed"
      ? "The iPhone packet targets the remote endpoint directly rather than representing an HTTP proxy exchange."
      : "This record does not contain enough path evidence to classify direct versus proxy routing.";

  const https: HttpsDiagnostic = proxyPlaintext ? "plaintext_observed"
    : connect ? "connect_only"
      : route === "direct_observed" ? "not_applicable"
        : "unresolved";
  const httpsLabel = https === "plaintext_observed" ? "HTTPS plaintext observed"
    : https === "connect_only" ? "HTTPS trust unresolved"
      : https === "not_applicable" ? "CA / pinning not assessed"
        : "HTTPS state unresolved";
  const httpsDetail = https === "plaintext_observed"
    ? "The proxy supplied HTTP inside an accepted TLS flow; this does not imply certificate-pinning bypass."
    : https === "connect_only"
      ? "CONNECT alone is not HTTPS plaintext. CA trust, certificate pinning, and client closure cannot be distinguished from this record."
      : https === "not_applicable"
        ? "A direct route does not test whether the proxy CA is trusted or whether the application pins certificates."
        : "No accepted proxy HTTPS request is attached to this record.";

  return {
    route,
    routeLabel,
    routeDetail,
    https,
    httpsLabel,
    httpsDetail,
    processLabel,
    inProcessLabel: inProcess ? "In-process visibility active" : "In-process visibility unavailable",
    inProcessDetail: inProcess
      ? "An active instrumentation evidence source is present."
      : "Only packet, syslog, and proxy evidence are available; no in-process TLS hook is active.",
  };
}

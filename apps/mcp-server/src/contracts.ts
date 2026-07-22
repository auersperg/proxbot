export type EndpointKind = "domain" | "ip";

export interface EndpointFilter {
  kind: EndpointKind;
  value: string;
}

export interface ExchangeQuery {
  sessionId: string;
  query: string;
  endpoint: EndpointFilter | null;
  offset: number;
  limit: number;
}

export interface RawArtifactRef {
  relativePath: string;
  offset: number;
  length: number;
  sha256: string | null;
}

export interface RawView {
  content: string;
  mediaType: string;
  evidence: string;
  reconstructed: boolean | null;
  truncated: boolean | null;
  masked: boolean | null;
  artifact: RawArtifactRef | null;
  outputTruncated: boolean;
  outputBytes: number;
  redactions: number;
}

export interface ExchangeRow {
  requestId: string;
  requestSequence: number | null;
  responseSequence: number | null;
  startedNs: string;
  method: string | null;
  scheme: string | null;
  host: string | null;
  ip: string | null;
  path: string | null;
  status: number | null;
  protocol: string | null;
  processName: string | null;
  durationMs: number | null;
  requestBytes: number | null;
  responseBytes: number | null;
  tls: string | null;
  evidence: string;
  warning: string | null;
  requestRaw?: RawView | null;
  responseRaw?: RawView | null;
}

export interface SessionSummary {
  sessionId: string;
  status: string;
  eventCount: number;
  exchangeCount: number | null;
  createdAt: string;
  ready: boolean;
}

export interface CaptureSnapshot {
  revision: number;
  status: string;
  sessionId: string | null;
  sessionDir: string | null;
  profile: "deep" | "passive" | null;
  device: Record<string, unknown> | null;
  metrics: Record<string, unknown>;
  sources: Array<{
    id: string;
    label: string;
    status: string;
    detail: string | null;
  }>;
  error: string | null;
}

export interface CaptureMarker {
  id: string;
  sessionId: string;
  label: string;
  createdAtMs: number;
}

export interface ControlAdapter {
  readonly available: boolean;
  startCapture(input: {
    profile: "deep" | "passive";
    deviceId?: string;
  }): Promise<CaptureSnapshot>;
  stopCapture(): Promise<CaptureSnapshot>;
  getStatus(): Promise<CaptureSnapshot>;
  addMarker(input: { label?: string }): Promise<CaptureMarker>;
}

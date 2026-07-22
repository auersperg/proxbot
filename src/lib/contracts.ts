export type EvidenceClass = "observed" | "enriched" | "inferred";
export interface RawArtifactRef {
  relativePath: string;
  offset: number;
  length: number;
  sha256: string | null;
}

export interface DevicePreflight {
  available: boolean;
  paired: boolean | null;
  trusted: boolean | null;
  id?: string;
  name?: string;
  type?: string;
  connectionType?: string;
  productType?: string;
  productVersion?: string;
  buildVersion?: string;
  developerMode?: boolean | null;
  error?: string;
}

export type CaptureStatus = "idle" | "starting" | "capturing" | "stopping" | "ready" | "degraded" | "error";
export type CaptureProfile = "deep" | "passive";
export type EvidenceSourceStatus = "active" | "idle" | "unavailable" | "error";

export interface CaptureMetrics {
  received: number | null;
  persisted: number | null;
  malformed: number | null;
  dropped: number | null;
  queueDepth: number | null;
  throughputPerSecond: number | null;
  driftMs: number | null;
  reconnects: number | null;
  lastEventAgeMs: number | null;
}

export interface EvidenceSource {
  id: string;
  label: string;
  status: EvidenceSourceStatus;
  detail: string | null;
}

export interface CaptureSnapshot {
  revision: number;
  status: CaptureStatus;
  sessionId: string | null;
  sessionDir: string | null;
  profile: CaptureProfile | null;
  device: DevicePreflight | null;
  metrics: CaptureMetrics;
  sources: EvidenceSource[];
  error: string | null;
}

export interface StartCaptureRequest {
  profile: CaptureProfile;
  deviceId: string | null;
}

export interface CaptureMarker {
  id: string;
  sessionId: string;
  createdAtMs: number;
  label: string;
}

export type EndpointKind = "domain" | "ip";

export interface EndpointSummary {
  kind: EndpointKind;
  value: string;
  count: number;
}

export interface RawView {
  content: string;
  mediaType: string;
  evidence: EvidenceClass;
  reconstructed: boolean | null;
  truncated: boolean | null;
  masked: boolean | null;
  artifact: RawArtifactRef | null;
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
  evidence: EvidenceClass;
  warning: string | null;
  requestRaw: RawView | null;
  responseRaw: RawView | null;
}

export interface ExchangePage {
  exchanges: ExchangeRow[];
  total: number;
}

export interface EndpointFilter {
  kind: EndpointKind;
  value: string;
}

export interface ExchangeQuery {
  query: string;
  endpoint: EndpointFilter | null;
  offset: number;
  limit: number;
}

export type EvidenceClass = "observed" | "enriched" | "inferred";
export interface RawArtifactRef {
  relativePath: string;
  offset: number;
  length: number;
  sha256: string | null;
}

export interface CaptureSummary {
  sessionId: string;
  sessionDir: string;
  eventCount: number;
}

export interface FridaPreflight {
  available: boolean;
  id?: string;
  name?: string;
  type?: string;
  error?: string;
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

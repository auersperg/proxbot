export type EvidenceClass = "observed" | "enriched" | "inferred";
export type ParseStatus = "raw" | "parsed" | "malformed";

export interface RawArtifactRef {
  relativePath: string;
  offset: number;
  length: number;
  sha256: string | null;
}

export interface ProviderEvent {
  schemaVersion: number;
  providerId: string;
  providerVersion: string;
  sessionId: string;
  sequence: number;
  sourceTimeNs: string;
  hostTimeNs: string;
  monotonicTimeNs: string | null;
  deviceId: string | null;
  processId: number | null;
  processName: string | null;
  evidence: EvidenceClass;
  kind: string;
  payload: unknown;
  rawRef: RawArtifactRef | null;
  parseStatus: ParseStatus;
}

export interface CaptureSummary {
  sessionId: string;
  sessionDir: string;
  eventCount: number;
}

export interface EventPage {
  events: ProviderEvent[];
  total: number;
}

export interface FridaPreflight {
  available: boolean;
  id?: string;
  name?: string;
  type?: string;
  error?: string;
}

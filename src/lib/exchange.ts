import type { CaptureLayer, PlaintextState } from "./contracts";

export function plaintextEvidenceLabel(value: { captureLayer: CaptureLayer; plaintextState: PlaintextState }): string {
  if (value.captureLayer === "process" && value.plaintextState === "observed") {
    return "PLAINTEXT OBSERVED IN PROCESS";
  }
  if (value.captureLayer === "proxy" && value.plaintextState === "decrypted") {
    return "PLAINTEXT DECRYPTED BY PROXY";
  }
  if (value.captureLayer === "proxy" && value.plaintextState === "observed") {
    return "PLAINTEXT OBSERVED BY PROXY";
  }
  if (value.captureLayer === "usb" && value.plaintextState === "not_observed") {
    return "USB PACKET · APP PLAINTEXT NOT OBSERVED";
  }
  if (value.captureLayer === "process") return "PROCESS EVIDENCE · PLAINTEXT UNVERIFIED";
  if (value.captureLayer === "proxy") return "PROXY EVIDENCE · PLAINTEXT UNVERIFIED";
  return "PROVIDER EVIDENCE · PLAINTEXT UNVERIFIED";
}

export function formatObservedTime(nanoseconds: string): string {
  const milliseconds = Number(BigInt(nanoseconds) / 1_000_000n);
  return new Date(milliseconds).toISOString().slice(11, 23);
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function responseLabel(status: number | null): string {
  return status === null ? "—" : String(status);
}

export function warningLabel(warning: string | null): string {
  if (warning === null) return "";
  return warning.split(";").map((value) => {
    const words = value.replaceAll("_", " ");
    return words.charAt(0).toUpperCase() + words.slice(1);
  }).join("; ");
}

export function statusTone(status: number | null): string {
  if (status === null) return "neutral";
  if (status >= 500) return "danger";
  if (status >= 400) return "warning";
  if (status >= 300) return "redirect";
  return "success";
}

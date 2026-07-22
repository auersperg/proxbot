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
  switch (warning) {
    case "response_missing": return "Response missing";
    case "request_missing": return "Request missing";
    case null: return "";
    default: return warning.replaceAll("_", " ");
  }
}

export function statusTone(status: number | null): string {
  if (status === null) return "neutral";
  if (status >= 500) return "danger";
  if (status >= 400) return "warning";
  if (status >= 300) return "redirect";
  return "success";
}

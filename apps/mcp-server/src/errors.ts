export type ErrorCode =
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "NOT_READY"
  | "INTEGRITY_ERROR"
  | "CONTROL_UNAVAILABLE"
  | "PROVIDER_UNAVAILABLE"
  | "TIMEOUT"
  | "INTERNAL";

export class ProxbotError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProxbotError";
    this.code = code;
    this.details = details;
  }
}

export function normalizeError(error: unknown): ProxbotError {
  if (error instanceof ProxbotError) return error;
  if (error instanceof Error) {
    return new ProxbotError("INTERNAL", error.message, {}, { cause: error });
  }
  return new ProxbotError("INTERNAL", "Unknown proxbot error");
}

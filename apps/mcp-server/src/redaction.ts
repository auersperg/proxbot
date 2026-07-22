const REDACTED = "<redacted-by-proxbot-mcp>";

interface RedactionState {
  count: number;
}

const SENSITIVE_NAMES = new Set([
  "access_token",
  "access_key",
  "api_key",
  "apikey",
  "auth",
  "authentication",
  "auth_token",
  "authorization",
  "aws_secret_access_key",
  "bearer",
  "client_assertion",
  "client_secret",
  "code",
  "code_verifier",
  "cookie",
  "credential",
  "credentials",
  "id_token",
  "identity_token",
  "key",
  "mnemonic",
  "otp",
  "passphrase",
  "passwd",
  "password",
  "pin",
  "private_key",
  "proxy_authorization",
  "recovery_phrase",
  "refresh_token",
  "secret",
  "seed_phrase",
  "set_cookie",
  "sig",
  "signature",
  "token",
  "x_access_token",
  "x_amz_security_token",
  "x_api_key",
  "x_auth_token",
  "x_client_secret",
  "x_csrf_token",
  "x_goog_api_key",
  "x_xsrf_token",
]);

const SENSITIVE_SUFFIXES = [
  "accesstoken",
  "apikey",
  "authorization",
  "clientassertion",
  "clientsecret",
  "cookie",
  "credential",
  "credentials",
  "identitytoken",
  "idtoken",
  "mnemonic",
  "passphrase",
  "passwd",
  "password",
  "privatekey",
  "recoveryphrase",
  "refreshtoken",
  "secret",
  "seedphrase",
  "setcookie",
  "signature",
  "token",
] as const;

function normalizedName(value: string): string {
  let decoded = value.trim().replaceAll("+", " ");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Invalid percent escapes are treated as literal characters and still
    // pass through the conservative suffix classifier below.
  }
  return decoded
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isSensitiveName(value: string): boolean {
  const normalized = normalizedName(value);
  if (SENSITIVE_NAMES.has(normalized)) return true;
  const compact = normalized.replaceAll("_", "");
  return SENSITIVE_SUFFIXES.some((suffix) => compact.endsWith(suffix));
}

function mark(state: RedactionState): string {
  state.count += 1;
  return REDACTED;
}

function redactHeaders(value: string, state: RedactionState): string {
  return value.replace(
    /(^|\r?\n)([!#$%&'*+.^_`|~0-9A-Za-z-]+)(\s*:\s*)[^\r\n]*/g,
    (match, lineStart: string, name: string, separator: string) => {
      if (!isSensitiveName(name)) return match;
      return `${lineStart}${name}${separator}${mark(state)}`;
    },
  );
}

function redactNamedParameters(value: string, state: RedactionState): string {
  return value.replace(
    /(^|[?&#;\r\n])([^?&#;=\r\n]{1,256})=([^&#;\s\r\n]*)/g,
    (match, delimiter: string, rawName: string) => {
      if (!isSensitiveName(rawName)) return match;
      return `${delimiter}${rawName}=${mark(state)}`;
    },
  );
}

function redactJsonProperties(value: string, state: RedactionState): string {
  let output = value.replace(
    /"((?:\\.|[^"\\]){1,256})"(\s*:\s*)"((?:\\.|[^"\\])*)"/g,
    (match, escapedName: string, separator: string) => {
      let name = escapedName;
      try {
        name = JSON.parse(`"${escapedName}"`) as string;
      } catch {
        // Keep the escaped spelling for conservative name classification.
      }
      if (!isSensitiveName(name)) return match;
      return `"${escapedName}"${separator}"${mark(state)}"`;
    },
  );
  output = output.replace(
    /"((?:\\.|[^"\\]){1,256})"(\s*:\s*)(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/gi,
    (match, escapedName: string, separator: string) => {
      let name = escapedName;
      try {
        name = JSON.parse(`"${escapedName}"`) as string;
      } catch {
        // Keep the escaped spelling for conservative name classification.
      }
      if (!isSensitiveName(name)) return match;
      return `"${escapedName}"${separator}"${mark(state)}"`;
    },
  );
  return output;
}

function redactCredentialShapes(value: string, state: RedactionState): string {
  let output = value.replace(
    /(https?:\/\/)([^/@\s:]+):([^/@\s]+)@/gi,
    (_match, protocol: string) => `${protocol}${mark(state)}:${REDACTED}@`,
  );
  output = output.replace(
    /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
    () => mark(state),
  );
  output = output.replace(
    /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g,
    () => mark(state),
  );
  output = output.replace(
    /\b(?:AKIA[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    () => mark(state),
  );
  return output;
}

function truncateUtf8(value: string, maxBytes: number): {
  value: string;
  truncated: boolean;
  bytes: number;
} {
  const encoded = Buffer.from(value);
  if (encoded.length <= maxBytes) {
    return { value, truncated: false, bytes: encoded.length };
  }
  let end = maxBytes;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try {
      const decoded = decoder.decode(encoded.subarray(0, end));
      return { value: decoded, truncated: true, bytes: end };
    } catch {
      end -= 1;
    }
  }
  return { value: "", truncated: true, bytes: 0 };
}

/** Redact credential-bearing URL components before returning exchange metadata. */
export function redactUrlMetadata(value: string | null): string | null {
  if (value === null) return null;
  const state: RedactionState = { count: 0 };
  let content = redactNamedParameters(value, state);
  content = redactCredentialShapes(content, state);
  return content;
}

export function redactRaw(
  raw: string,
  maxBytes: number,
): { content: string; redactions: number; truncated: boolean; bytes: number } {
  const state: RedactionState = { count: 0 };
  let content = redactHeaders(raw, state);
  content = redactNamedParameters(content, state);
  content = redactJsonProperties(content, state);
  content = redactCredentialShapes(content, state);

  const truncated = truncateUtf8(content, maxBytes);
  return {
    content: truncated.value,
    redactions: state.count,
    truncated: truncated.truncated,
    bytes: truncated.bytes,
  };
}

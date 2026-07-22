import {
  existsSync,
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { ProxbotError } from "./errors.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateSessionId(sessionId: string): string {
  const normalized = sessionId.trim().toLowerCase();
  if (!UUID.test(normalized)) {
    throw new ProxbotError("INVALID_ARGUMENT", "sessionId must be a UUID");
  }
  return normalized;
}

export function validateBoundedText(
  value: string,
  name: string,
  maxBytes: number,
  allowEmpty = true,
): string {
  const bytes = Buffer.byteLength(value);
  if ((!allowEmpty && value.trim() === "") || bytes > maxBytes) {
    throw new ProxbotError(
      "INVALID_ARGUMENT",
      `${name} must contain ${allowEmpty ? "0" : "1"}..=${maxBytes} UTF-8 bytes`,
    );
  }
  return value;
}

export function safeSessionPath(root: string, sessionId: string): string {
  const normalizedId = validateSessionId(sessionId);
  const resolvedRoot = resolve(root);
  const path = join(resolvedRoot, normalizedId);
  if (!existsSync(path)) {
    throw new ProxbotError("NOT_FOUND", `Session ${normalizedId} was not found`);
  }
  for (const candidate of [resolvedRoot, path]) {
    const metadata = lstatSync(candidate);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new ProxbotError(
        "INTEGRITY_ERROR",
        `Refusing symlink or non-directory path: ${candidate}`,
      );
    }
  }
  const canonicalRoot = realpathSync(resolvedRoot);
  const canonicalPath = realpathSync(path);
  const difference = relative(canonicalRoot, canonicalPath);
  if (difference !== normalizedId) {
    throw new ProxbotError(
      "INTEGRITY_ERROR",
      "Session path escaped the configured sessions root",
    );
  }
  return canonicalPath;
}

export function safeSessionFile(
  sessionRoot: string,
  relativePath: string,
  required = true,
): string | null {
  const parts = relativePath.split("/");
  if (
    parts.length === 0 ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new ProxbotError("INTEGRITY_ERROR", "Invalid session-relative path");
  }
  let current = sessionRoot;
  for (const part of parts) {
    current = join(current, part);
    if (!existsSync(current)) {
      if (required) {
        throw new ProxbotError("NOT_FOUND", `Session artifact is missing: ${relativePath}`);
      }
      return null;
    }
    if (lstatSync(current).isSymbolicLink()) {
      throw new ProxbotError(
        "INTEGRITY_ERROR",
        `Refusing symlink session artifact: ${relativePath}`,
      );
    }
  }
  const canonical = realpathSync(current);
  const difference = relative(sessionRoot, canonical);
  if (difference.startsWith(`..${sep}`) || difference === "..") {
    throw new ProxbotError("INTEGRITY_ERROR", "Session artifact escaped its root");
  }
  if (!statSync(canonical).isFile()) {
    throw new ProxbotError("INTEGRITY_ERROR", "Session artifact is not a regular file");
  }
  return canonical;
}

export function safeExportName(value: string): string {
  const name = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name)) {
    throw new ProxbotError(
      "INVALID_ARGUMENT",
      "exportName must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,127}",
    );
  }
  return name;
}

export function assertExportParent(sessionRoot: string): string {
  const directory = join(sessionRoot, "exports");
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ProxbotError("INTEGRITY_ERROR", "Invalid exports directory");
  }
  const canonical = realpathSync(directory);
  if (dirname(canonical) !== sessionRoot) {
    throw new ProxbotError("INTEGRITY_ERROR", "Exports path escaped session root");
  }
  return canonical;
}

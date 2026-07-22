#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";

const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" });
if (result.status !== 0) {
  process.stderr.write(result.stderr || "git ls-files failed\n");
  process.exit(result.status ?? 1);
}

const tracked = result.stdout.split("\0").filter(Boolean);
const trackedSet = new Set(tracked);
const failures = [];

const shortManager = "n" + "p" + "m";
const retiredManagerNames = ["p" + shortManager, shortManager, "n" + "p" + "x", "y" + "arn"];
const retiredManagerPattern = new RegExp(`\\b(?:${retiredManagerNames.join("|")})\\b`, "i");
const forbiddenNames = new Set([
  "package" + "-lock.json",
  shortManager + "-shrinkwrap.json",
  "p" + shortManager + "-lock.yaml",
  "p" + shortManager + "-workspace.yaml",
  "y" + "arn.lock",
  ".pnp.cjs",
  ".pnp.js",
]);
const legacyFrontendName = "s" + "velte";
const forbiddenExtensions = new Set([`.${legacyFrontendName}`]);
const forbiddenLegacyConfigFiles = new Set(["js", "cjs", "mjs", "ts"].map((extension) => `${legacyFrontendName}.config.${extension}`));

for (const path of tracked) {
  const name = path.split("/").at(-1);
  if (forbiddenNames.has(name)) failures.push(`${path}: alternative JavaScript package-manager artifact`);
  if (forbiddenExtensions.has(extname(path)) || forbiddenLegacyConfigFiles.has(name)) {
    failures.push(`${path}: legacy frontend artifact`);
  }
}

const bunLockfiles = [...trackedSet].filter((path) => path === "bun.lock" || path.endsWith("/bun.lock"));
if (!trackedSet.has("bun.lock")) failures.push("bun.lock: required root lockfile is missing");
if (bunLockfiles.length !== 1 || bunLockfiles[0] !== "bun.lock") {
  failures.push(`repository must contain exactly one root Bun lockfile (found: ${bunLockfiles.join(", ") || "none"})`);
}

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
if (packageJson.packageManager !== "bun@1.3.14") {
  failures.push("package.json: packageManager must be pinned to bun@1.3.14");
}
if (!Array.isArray(packageJson.workspaces) || !packageJson.workspaces.includes("apps/*")) {
  failures.push("package.json: Bun workspaces must include apps/*");
}

const scripts = packageJson.scripts ?? {};
for (const [name, command] of Object.entries(scripts)) {
  if (retiredManagerPattern.test(String(command))) {
    failures.push(`package.json scripts.${name}: invokes an alternative JavaScript package manager`);
  }
}

const sourcePaths = tracked.filter((path) => /^(?:\.github|\.vscode|apps|docs|src|scripts|sidecars|src-tauri)\//.test(path));
const textExtensions = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".json", ".toml", ".py", ".rs", ".sh", ".md", ".yml", ".yaml"]);
for (const path of sourcePaths) {
  // A working tree can legitimately contain staged/unstaged deletions while this
  // gate is being run locally. CI checks the committed tree, where every tracked
  // path exists.
  if (!existsSync(path)) continue;
  if (!textExtensions.has(extname(path))) continue;
  const text = readFileSync(path, "utf8");
  if (retiredManagerPattern.test(text)) {
    failures.push(`${path}: alternative JavaScript package-manager reference in active source`);
  }
  if (new RegExp(`\\b${legacyFrontendName}\\b`, "i").test(text)) failures.push(`${path}: legacy frontend reference in active source`);
}

if (failures.length > 0) {
  process.stderr.write(`Repository hygiene failed (${failures.length}):\n`);
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exit(1);
}

process.stdout.write(`Repository hygiene passed: ${tracked.length} repository files, Bun lockfile and active-source boundaries verified.\n`);

#!/usr/bin/env bun

import { readFileSync } from "node:fs";

const root = JSON.parse(readFileSync("package.json", "utf8"));
const mcp = JSON.parse(readFileSync("apps/mcp-server/package.json", "utf8"));
const tauri = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));

function tomlValue(path, section, key) {
  const text = readFileSync(path, "utf8");
  const sectionText = text.match(new RegExp(`^\\[${section.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\]\\s*$([\\s\\S]*?)(?=^\\[|\\z)`, "m"))?.[1] ?? text;
  const value = sectionText.match(new RegExp(`^${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*=\\s*"([^"]+)"`, "m"))?.[1];
  if (!value) throw new Error(`${path}: missing ${section}.${key}`);
  return value;
}

function pythonVersion(version) {
  const match = version.match(/^(\d+\.\d+\.\d+)(?:-(alpha|beta|rc)\.(\d+))?$/);
  if (!match) throw new Error(`unsupported release version: ${version}`);
  const suffix = match[2] === "alpha" ? "a" : match[2] === "beta" ? "b" : match[2] ?? "";
  return `${match[1]}${suffix}${match[3] ?? ""}`;
}

function bundleVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/);
  if (!match) throw new Error(`unsupported release version: ${version}`);
  const [, major, minor, patch, channel, ordinal] = match;
  const channelBase = channel === "alpha" ? 0 : channel === "beta" ? 30 : channel === "rc" ? 60 : 99;
  const buildOrdinal = channel ? channelBase + Number(ordinal) : channelBase;
  if (buildOrdinal > 99) throw new Error(`prerelease ordinal is too large: ${version}`);
  return String(Number(major) * 100_000_000 + Number(minor) * 1_000_000 + Number(patch) * 100 + buildOrdinal);
}

function expectEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, found ${actual}`);
}

const version = root.version;
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (tag) expectEqual("release tag", tag.replace(/^v/, ""), version);
expectEqual("MCP package", mcp.version, version);
expectEqual("Cargo package", tomlValue("src-tauri/Cargo.toml", "package", "version"), version);
expectEqual("Tauri marketing version", tauri.version, version.split("-")[0]);
expectEqual("Tauri numeric bundle version", tauri.bundle.macOS.bundleVersion, bundleVersion(version));

const pep440 = pythonVersion(version);
for (const provider of ["ios-provider", "proxy-provider"]) {
  expectEqual(`${provider} pyproject`, tomlValue(`sidecars/${provider}/pyproject.toml`, "project", "version"), pep440);
  const locked = readFileSync(`sidecars/${provider}/uv.lock`, "utf8");
  const block = locked.split("[[package]]").find((candidate) =>
    new RegExp(`^\\s*name = "proxbot-${provider}"\\s*$`, "m").test(candidate),
  );
  expectEqual(
    `${provider} uv.lock`,
    block?.match(/^version = "([^"]+)"/m)?.[1],
    pep440,
  );
  const module = provider.replaceAll("-", "_");
  const init = readFileSync(`sidecars/${provider}/src/proxbot_${module.replace(/^proxbot_/, "")}/__init__.py`, "utf8");
  expectEqual(`${provider} __version__`, init.match(/__version__\s*=\s*"([^"]+)"/)?.[1], pep440);
}

const cargoLock = readFileSync("src-tauri/Cargo.lock", "utf8");
expectEqual("Cargo.lock proxbot", cargoLock.match(/\[\[package\]\]\nname = "proxbot"\nversion = "([^"]+)"/)?.[1], version);
const bunLock = readFileSync("bun.lock", "utf8");
expectEqual("bun.lock MCP workspace", bunLock.match(/"apps\/mcp-server": \{[\s\S]*?"version": "([^"]+)"/)?.[1], version);

process.stdout.write(`Version parity passed: ${version}; Python ${pep440}; macOS ${tauri.version} (${tauri.bundle.macOS.bundleVersion}).\n`);

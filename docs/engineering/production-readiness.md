# Production readiness and agent automation

This document is the integration checklist for the production capture workspace and its agent-facing MCP surface. A checked item must be supported by an automated test or a reproducible release artifact; UI labels and fixture output are not completion evidence.

## Bun workspace boundary

- `bun.lock` is the only JavaScript dependency lockfile.
- Bun is the only JavaScript installer and script runner used by active source, CI, Tauri hooks, and release automation.
- `bun install --frozen-lockfile` is mandatory in CI and release jobs.
- `bun scripts/repository-hygiene.mjs` rejects alternative package-manager artifacts, legacy frontend source/configuration, and active-source references to retired tooling.
- Root scripts remain the single command surface; packages added later must be declared as Bun workspaces rather than introducing another workspace orchestrator.

## Production capture acceptance gates

- [ ] Starting capture selects a real paired USB device and returns a stable session ID.
- [ ] Device metadata, packet capture, device logs, proxy events, and approved instrumentation events share one monotonic session timeline.
- [ ] The UI opens an existing or newly created real session; production startup never silently selects fixture evidence.
- [ ] Capture start, stop, cancellation, provider crash, reconnect, backpressure, and disk-pressure behavior have integration tests.
- [ ] Health counters are sourced from provider/runtime state rather than UI placeholders.
- [ ] Raw request and response bytes retain side-specific provenance, hashes, offsets, reconstruction, truncation, and masking state.
- [ ] HTTP/1.1, HTTP/2, WebSocket, binary bodies, absent responses, and CONNECT tunnels have local end-to-end fixture-server tests.
- [ ] TLS interception uses an explicitly managed local CA with install, trust-state, rotation, removal, and rollback workflows.
- [ ] Instrumentation is scoped to owned laboratory builds and reports exact hook coverage and gaps.
- [ ] Session export supports deterministic manifests, checksums, redaction profiles, and integrity verification.
- [ ] Solana analysis distinguishes message construction, wallet signature, Privy RPC signing, application backend calls, RPC submission, transaction signature, confirmation, and failure.
- [ ] A four-hour device soak and a ten-million-event browse test publish machine specifications, throughput, memory, latency, loss, and recovery results.

## MCP server contract

The MCP server is a thin adapter over the same capture/session contracts used by Tauri. Mutating operations always cross the capture coordinator's control boundary. Bounded reads may use the versioned, read-only session index through one repository adapter; tools never write SQLite directly or spawn provider processes independently of the coordinator.

### Transport and lifecycle

- Local `stdio` transport is the default for desktop agent automation.
- Optional local Streamable HTTP binds to loopback only, uses an ephemeral bearer token, and is disabled unless the user enables it.
- The desktop app owns the capture/session runtime. MCP attaches through a versioned local IPC boundary and exits cleanly when the app is unavailable.
- Every tool accepts `request_id`; mutating calls are idempotent and return the effective state.
- Long-running capture/export operations return an operation ID and expose progress/cancellation rather than holding one request indefinitely.

### Minimal tool surface

| Tool | Purpose | Mutating |
|---|---|---:|
| `devices.list` | Return paired USB devices and trust/developer-mode state | no |
| `sessions.list` | Page bounded session metadata | no |
| `sessions.get` | Read one session state and health summary | no |
| `capture.start` | Start a real capture with explicit device/providers/options | yes |
| `capture.stop` | Flush, finalize, checksum, and publish one session | yes |
| `capture.cancel` | Cancel a pending/running operation with explicit final state | yes |
| `exchanges.list` | Page metadata with bounded query/endpoint/cursor inputs | no |
| `exchanges.get` | Read one exchange and side-specific raw provenance | no |
| `artifacts.read` | Read a bounded byte range after policy/redaction checks | no |
| `analysis.run` | Run a named deterministic analyzer against a finalized session | yes |
| `exports.create` | Create a redacted HAR/JSONL/session bundle | yes |
| `operations.get` | Read progress and terminal result | no |

### MCP safety and observability

- Tool schemas use closed JSON objects, explicit enums, byte/row/time limits, and opaque cursor tokens.
- Mutating tools require the desktop application's local approval policy; external agents never receive signing keys, private keys, seed phrases, CA private material, or refresh tokens.
- Tool results distinguish observed evidence, deterministic enrichment, and inference.
- Secrets are redacted before serialization and are never written to MCP logs.
- Audit records include timestamp, agent/client identity, tool, sanitized arguments hash, operation/session ID, result status, duration, and cancellation state.
- Trace context propagates MCP request → service command → provider → storage so one operation is diagnosable end to end.
- Subscriptions expose bounded progress/event notifications; slow consumers receive gap markers and resume cursors instead of causing unbounded buffering.

## CI and release gates

`.github/workflows/quality.yml` runs repository hygiene, the locked Bun frontend suite/build, provider tests, Rust formatting, Rust tests, and Clippy. `.github/workflows/release.yml` repeats the complete gate from a version tag, checks version parity, builds the macOS arm64 bundle, verifies its signature and ZIP integrity, emits SHA-256, retains the workflow artifact, and publishes the same files to the GitHub release.

Public distribution additionally requires configured Apple Developer ID signing and notarization. A release is production-distributable only when Gatekeeper assessment and notarization verification are included in the release record.

# proxbot production readiness and verified boundary

This record describes what `v0.2.0-rc.1` actually executes. A UI label, fixture, or planned milestone is not treated as evidence.

## Verified runtime

- [x] React 19/Vite frontend contains no production demo client or demo action.
- [x] Device preflight returns a typed available/paired/trusted USB result.
- [x] Preflight calls are serialized and briefly cached to prevent concurrent usbmux contention.
- [x] `passive` starts USB PCAPNG; `deep` starts USB PCAPNG plus syslog JSONL.
- [x] Provider readiness is emitted only after requested capture outputs initialize.
- [x] Early/missing artifacts produce an explicit provider failure instead of a ready claim.
- [x] Tauri and MCP use the same `LiveCaptureService` source of truth.
- [x] `capture://status` publishes small monotonic snapshots; raw evidence remains paged.
- [x] Stop uses SIGTERM, a bounded deadline, forced termination fallback, provider join, durable finalization, and terminal snapshot.
- [x] Final session JSONL, PCAPNG, and syslog artifacts are owner-only and SHA-256 recorded.
- [x] Manifest is written last and identifies every checksummed authoritative artifact.
- [x] PCAPNG finalization validates block lengths, trims only an incomplete cancellation tail, and writes an explicit libpcap-compatible snaplen.
- [x] Hardware smoke exercises agent → official MCP stdio → owner-only UDS → Tauri → bundled provider → USB iPhone → finalized session.

## Evidence semantics

- USB PCAP is `encrypted_network_packets` and never presented as application plaintext.
- USB syslog is `device_syslog` and never presented as network payload decryption.
- Live events carry `fixture:false`, `application_plaintext:false`, and `tls_decryption:false`.
- The optional mitmproxy provider reports plaintext only for clients explicitly routed through it whose trust policy accepts its CA.
- CA installation and certificate-pinning bypass are not performed; provider capabilities report `certificate_pinning_bypass:false`.
- Solana transaction decoding/signature/broadcast correlation is not inferred from packet capture alone. It becomes an analysis claim only when corresponding indexed proxy or instrumentation evidence exists.

## MCP server

Transport: official MCP JSON-RPC over stdio. The MCP process opens no network listener.

Mutating tools use the running app's owner-only, non-symlink Unix socket and a strict one-request/one-response envelope:

```json
{"version":1,"id":"UUID","method":"METHOD","params":{}}
```

The bridge enforces a 64 KiB line/frame limit, exact protocol version, UUID correlation, allowlisted method, closed params, owner UID, `0600` mode, connect/response deadlines, and response-ID match.

Finalized-session reads use one confined repository adapter:

- UUID-only session paths directly below the configured root;
- symlink/traversal refusal;
- SQLite `readonly`, `query_only=ON`, `trusted_schema=OFF`;
- dirty-index refusal;
- metadata pages before one selected raw exchange;
- independent UTF-8 byte caps and credential redaction;
- metadata-only `0600` export with exclusive partial write, `fsync`, atomic rename, and directory `fsync`.

The exposed tool surface is the 13 `proxbot_*` tools documented in the root README. Tool inputs use Zod schemas and MCP annotations; stdout is reserved for protocol frames and diagnostics go to stderr.

## Bun workspace and CI

- [x] `bun@1.3.14` pinned in root `packageManager`.
- [x] a single root `bun.lock`.
- [x] `apps/*` uses Bun workspaces with isolated linking.
- [x] no alternate JavaScript package-manager files or commands in active source.
- [x] frontend and MCP test/type/build commands originate at the root.
- [x] both Python providers have isolated, frozen `uv.lock` environments.
- [x] CI covers Bun hygiene/install/test/check/build, both Python suites/compileall, Rust fmt/test/Clippy.
- [x] tag release repeats quality gates and requires Developer ID signing and notarization before publication.

## Remaining post-RC qualification

These are not represented as completed by this RC:

- automatic iPhone proxy profile/CA installation and removal UX;
- lab-build instrumentation integration and per-hook coverage UI;
- deterministic protocol/Solana analyzer and cross-source correlation;
- HAR/session bundle export with configurable redaction profiles;
- disk-pressure/fault-injection campaign;
- four-hour device soak and ten-million-event browse benchmark;
- verified Apple Developer ID notarized artifact, pending repository release credentials.

The RC is therefore a production-quality capture/automation foundation, not a claim that every broader research milestone is already integrated.

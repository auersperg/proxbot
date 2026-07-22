# proxbot Complete MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the verified TraceLab foundation into a self-contained, signed `proxbot.app` that captures and correlates iPhone USB packets, logs, processes, proxy traffic, laboratory-build instrumentation, wallet/Solana events, and verified exports.

**Architecture:** Tauri 2 and Rust remain the trusted coordinator, evidence store, analysis scheduler, export engine, and UI query boundary. Bundled Python providers implement iOS/Frida integration behind the existing versioned MessagePack protocol; the local Rust proxy and analyzers append raw evidence before normalized or inferred records are created.

**Tech Stack:** Tauri 2, Rust stable, Tokio, rusqlite, rcgen/rustls, pcap-file, serde, MessagePack, Svelte 5, TypeScript, Vitest, Python 3.14, uv, Frida 17, pymobiledevice3, Solana message parsing.

## Global Constraints

- Product name is exactly `proxbot`; bundle identifier is `com.auersperg.proxbot`.
- Target macOS 14+ on Apple Silicon and a paired USB-connected non-jailbroken iPhone.
- Preserve raw provider data before derived analysis and never relabel fixture or enrichment traffic as device-observed traffic.
- Every fact is `observed`, `enriched`, or `inferred`; every inference stores confidence and supporting event references.
- No telemetry, no automatic upload, no seed/private-key persistence, and sanitized exports redact authorization material by default.
- SQLite is a rebuildable index; finalized evidence is append-only and checksum-covered.
- Providers expose received, persisted, malformed, dropped, reconnect, and last-event counters.
- Every behavior change follows red-green-refactor TDD and every milestone ends with a verified runnable app.

---

## File Map

```text
src-tauri/src/device/           device inventory, tunnel and service preflight
src-tauri/src/providers/        pcap, log, process, proxy and instrumentation adapters
src-tauri/src/proxy/            local CA, HTTP CONNECT, TLS/HTTP/WebSocket capture
src-tauri/src/analysis/         network, wallet, Solana and correlation analyzers
src-tauri/src/lab_build/        transactional IPA/app preparation and signing
src-tauri/src/export/           HAR, JSONL, bundle, redaction and checksum manifests
src-tauri/src/recovery/         partial-session validation, reindex and finalization
sidecars/ios-provider/          Frida and pymobiledevice3 runtime/provider commands
instrumentation/               versioned Frida JavaScript observation modules
src/lib/components/             device, capture, flow, wallet and export UI
fixtures/                       deterministic protocol and Solana golden sessions
```

### Task 1: Product Identity and GitHub Publication

**Files:** `package.json`, `src/lib/app-meta.ts`, `src/lib/app-meta.test.ts`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs`, `README.md`

**Interfaces:** Produces `APP_META = { name: "proxbot", bundleIdentifier: "com.auersperg.proxbot" }`, `proxbot_lib`, `proxbot.app`, and GitHub `main`.

- [ ] Change the existing APP_META test first to expect the exact proxbot identity and run `pnpm test src/lib/app-meta.test.ts` to observe the TraceLab mismatch.
- [ ] Rename the visible app, package, Rust binary/library, capability description, socket prefix, documentation headings, and bundle identifier while preserving old design history as an explicitly superseded record.
- [ ] Run frontend, Rust, Python, build, and configuration checks.
- [ ] Add `origin=https://github.com/auersperg/proxbot.git`, verify the repository is empty, and push the stable commit to `main`.
- [ ] Commit `refactor: rename application to proxbot`.

### Task 2: Self-Contained Provider Runtime

**Files:** `src-tauri/src/provider/runtime.rs`, `src-tauri/tests/provider_runtime.rs`, `src-tauri/tauri.conf.json`, `scripts/build-provider-sidecar.sh`

**Interfaces:** Produces `ProviderRuntime::resolve(resource_dir, app_data_dir)` and a bundled `proxbot-ios-provider` executable that never depends on a source checkout.

- [ ] Write a Rust test with a temporary resource directory that expects the packaged provider path and SHA-256 verification result.
- [ ] Add a deterministic sidecar build that stages only source, lockfile, licenses, and the executable; exclude `.venv`, cache, tokens, and local paths.
- [ ] Configure Tauri resources/external binaries and resolve them through `app.path().resource_dir()`.
- [ ] Verify a copied `.app` still performs Frida preflight after the source worktree is temporarily unavailable.
- [ ] Commit `build: bundle proxbot iOS provider`.

### Task 3: Device, Tunnel, Process, Log, and PCAP Providers

**Files:** `sidecars/ios-provider/src/proxbot_ios_provider/{device,tunnel,process,logs,pcap}.py`, provider tests, `src-tauri/src/providers/ios.rs`, `src-tauri/tests/ios_provider_contract.rs`

**Interfaces:** Produces provider subcommands `probe`, `capture-pcap`, `capture-logs`, and `watch-process`; raw artifacts `device-raw.pcap`, `syslog.jsonl`, and `process-map.jsonl`.

- [ ] Write dependency-injected Python tests for paired-device inventory, iOS 17+ tunnel selection, packet metadata preservation, raw-log preservation, PID lifecycle, disconnect, and structured service errors.
- [ ] Implement pymobiledevice3 adapters that emit the existing schema and spool raw files directly into provider-owned `.partial` paths.
- [ ] Extend the Rust supervisor with dependency-ordered start/stop, bounded restart backoff, graceful flush, sequence-gap events, and per-provider counters.
- [ ] Add a hardware preflight command that reports pairing, trust, model, iOS version, tunnel, services, free space, and tool versions with UDID redaction in the UI.
- [ ] Commit `feat: capture iPhone packets logs and processes`.

### Task 4: Full Capture Coordinator and Recovery

**Files:** `src-tauri/src/capture/coordinator.rs`, `src-tauri/src/recovery/mod.rs`, `src-tauri/tests/{capture_lifecycle,recovery}.rs`

**Interfaces:** Produces `prepare_capture`, `start_capture`, `add_marker`, `stop_capture`, `recover_sessions`, and final status `ready|ready_with_warnings|incomplete|corrupted`.

- [ ] Write failing integration tests for dependency order, optional-provider degradation, controlled stop order, disk pressure, disconnect/reconnect, process crash, and interrupted `.partial` recovery.
- [ ] Implement the state machine lifecycle from store startup through PCAP-last shutdown and atomic checksum finalization.
- [ ] Rebuild SQLite solely from append-only artifacts and record the recovered byte/event boundary.
- [ ] Expose capture elapsed time, written size, queue depth, drift, reconnects, and last-event age to the UI.
- [ ] Commit `feat: orchestrate recoverable capture sessions`.

### Task 5: Local Proxy and Certificate Management

**Files:** `src-tauri/src/proxy/{ca,server,http1,http2,websocket,tls}.rs`, `src-tauri/tests/proxy_capture.rs`, `src/lib/components/ProxyPanel.svelte`

**Interfaces:** Produces a loopback-only proxy, per-session leaf certificates, CONNECT metadata, HTTP/1.1 flows, HTTP/2 streams, WebSocket frames, TLS metadata, and explicit proxy configuration/cleanup actions.

- [ ] Write tests using local fixture servers for CONNECT tunneling, request/response streaming, binary bodies, HTTP/2 multiplexing, WebSocket frames, malformed messages, body limits, and cancellation.
- [ ] Generate a local CA with private material stored outside logs/events; add explicit install/remove workflows and fingerprint display.
- [ ] Stream large bodies into content-addressed files and place only metadata/references on the event channel.
- [ ] Record proxy changes in the manifest and restore only settings previously changed by proxbot.
- [ ] Commit `feat: add loss-aware local traffic proxy`.

### Task 6: Laboratory Build and Instrumentation Profiles

**Files:** `src-tauri/src/lab_build/{inventory,transform,sign,install}.rs`, `instrumentation/{bootstrap,trust,network,socket,wallet}.js`, tests and fixtures

**Interfaces:** Produces transactional `prepare_lab_build(input, profile, signing)` and profiles `observe`, `capture`, and `lab_allow` with exact hook coverage.

- [ ] Write tests around an unsigned fixture `.app` for SHA-256 inventory, Mach-O/framework enumeration, bundle-ID suffixing, nested signing order, signature verification, rollback, and immutable source input.
- [ ] Implement isolated working copies, instrumentation embedding, configuration, entitlement compatibility checks, inside-out signing, install, and exact transformation manifests.
- [ ] Add Frida modules that report trust calls, original trust result, hostname, chain fingerprint, networking stack, plaintext metadata, socket metadata, wallet method, thread, and stack fingerprint.
- [ ] Make `lab_allow` record the original decision before applying its laboratory continuation result; emit explicit coverage gaps for unavailable hooks.
- [ ] Commit `feat: prepare and instrument laboratory builds`.

### Task 7: Network, Wallet, and Solana Analysis

**Files:** `src-tauri/src/analysis/{network,correlation,wallet,solana}.rs`, golden fixtures and tests, `src/lib/components/{FlowInspector,WalletTrace,SolanaInspector}.svelte`

**Interfaces:** Produces normalized flows, confidence-scored correlations, decoded legacy/v0 Solana messages, and explicit `unsigned -> sign request -> signed response -> broadcast -> optional enrichment` traces.

- [ ] Add golden tests for DNS/TCP/TLS/HTTP/JSON-RPC, Privy-style `signTransaction`, signed base64 payloads, legacy and v0 messages, lookup tables, compute budgets, token instructions, failed transactions, and backend-mediated broadcast.
- [ ] Implement flow correlation using PID, process lifecycle, 5-tuple, socket metadata, timestamps, byte counts, request IDs, hostnames, and stack fingerprints; persist matches, conflicts, confidence, and analyzer version.
- [ ] Decode Solana headers, account keys, recent blockhash, instructions, program IDs, lookup tables, fee payer, signatures, token accounts, mints, and amounts without exposing key material.
- [ ] Keep signing and broadcasting as separate evidence states and label explicit RPC lookups `ENRICHED`.
- [ ] Commit `feat: correlate wallet and Solana evidence`.

### Task 8: Export, Sanitization, and Reindexing

**Files:** `src-tauri/src/export/{har,jsonl,bundle,redact}.rs`, `src-tauri/tests/export_contract.rs`, `src/lib/components/ExportDialog.svelte`

**Interfaces:** Produces raw, sanitized, and metadata-only bundles plus PCAP, HAR, JSONL, SQLite snapshot, Markdown/JSON summaries, redaction report, and output checksums.

- [ ] Write tests that seed authorization headers, cookies, email, wallet identifiers, access/refresh tokens, and configured JSON fields; assert none enter sanitized exports and relationships use stable replacements.
- [ ] Implement streaming exporters with source session UUID/checksums, analyzer versions, filter/time range, evidence classes, redaction mode, and output checksum manifest.
- [ ] Add deterministic reindex tests proving artifact counts and normalized transaction traces match before and after SQLite deletion.
- [ ] Add an exact export manifest preview in the UI before writing.
- [ ] Commit `feat: export verified sanitized evidence bundles`.

### Task 9: Performance, Fuzzing, Packaging, and Release Gate

**Files:** `fuzz/`, `benches/`, `scripts/verify-release.sh`, `.github/workflows/ci.yml`, `docs/testing/proxbot-mvp-verification.md`

**Interfaces:** Produces signed/notarization-ready `proxbot.app`, DMG/ZIP checksums, CI, fuzz/property results, hardware verification, and a reproducible release report.

- [ ] Add fuzz/property targets for MessagePack length frames, truncated JSONL/PCAP, headers/bodies, Solana messages, and redaction invariants.
- [ ] Add ingestion, paging, recovery, and reindex benchmarks with machine-readable results and enforced queue bounds.
- [ ] Run all unit/integration/golden tests, `svelte-check`, Rust fmt/clippy, Python lint/tests, bundle build, strict codesign, archive integrity, and copied-app preflight.
- [ ] Execute a real iPhone capture with PCAP/log/process coverage and an instrumented laboratory transaction; record observed gaps rather than editing them out.
- [ ] Push the verified final source and release metadata to GitHub `main` and tag `v0.1.0` only after the gate passes.
- [ ] Commit `release: verify proxbot 0.1.0 MVP`.

## Completion Gate

- [ ] `proxbot.app` is self-contained relative to its source checkout and launches on macOS 14+ Apple Silicon.
- [ ] USB device, packet, log, process, proxy, and instrumentation provider coverage is visible with received/persisted/dropped counters.
- [ ] A laboratory-build pinned-TLS wallet transaction produces raw PCAP plus correlated application plaintext without mislabeling correlation as packet decryption.
- [ ] Signing and broadcast are separate and a Solana transaction is decoded from observed evidence.
- [ ] Raw and sanitized bundles verify checksums and rebuild the same index/trace.
- [ ] Recovery preserves the last complete record after forced interruption.
- [ ] All automated, hardware, signature, archive, and copied-app checks pass.
- [ ] GitHub `auersperg/proxbot` `main` matches the verified local commit.

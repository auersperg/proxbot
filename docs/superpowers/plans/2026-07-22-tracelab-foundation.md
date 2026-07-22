# TraceLab Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a signed, runnable macOS TraceLab application that discovers the USB iPhone through Frida, executes deterministic provider captures over the production IPC boundary, stores sessions losslessly, indexes them in SQLite, and exposes a usable capture timeline.

**Architecture:** Tauri 2 hosts a Svelte 5 UI and a Rust core. Rust owns session state, append-only artifacts, SQLite, provider supervision, and paged queries. A Python sidecar owns Frida/iOS integration and streams versioned, length-prefixed MessagePack events over a Unix domain socket.

**Tech Stack:** Tauri 2, Rust stable, Tokio, Serde, MessagePack, rusqlite, Svelte 5, TypeScript, Vite, Vitest, pnpm 11, Python 3.14, uv, msgpack, Frida 17.8.x.

## Global Constraints

- Target macOS 14+ on Apple Silicon.
- Support a paired USB-connected non-jailbroken iPhone.
- Preserve raw provider records before derived analysis.
- Label every fact `observed`, `enriched`, or `inferred`.
- Record provider sequence gaps instead of hiding them.
- Keep raw binary bodies out of the frontend event channel.
- Treat SQLite as a rebuildable index, not the sole source of truth.
- Use deny-by-default Tauri capabilities and emit no telemetry.
- Follow red-green-refactor TDD and commit each independently testable task.

## Scope Decomposition

The approved design contains five large subsystems. This plan implements the independently usable foundation and Frida-first control plane. Follow-on plans extend the same interfaces with real `pcapd`/syslog, laboratory-build pinned-TLS hooks, the HTTP(S) proxy, Solana correlation, sanitized export, and performance qualification.

## File Map

```text
src/                               Svelte UI and typed command client
src-tauri/src/domain/              provider events and session state machine
src-tauri/src/store/               append-only storage and SQLite index
src-tauri/src/provider/            MessagePack codec and process supervisor
src-tauri/src/commands.rs          Tauri command boundary
sidecars/ios-provider/             Python fake and Frida providers
tests across each package          unit and integration coverage
```

### Task 1: Bootstrap Tauri, Svelte, Rust, and Vitest

**Files:** `package.json`, `vite.config.ts`, `rust-toolchain.toml`, `src/lib/app-meta.ts`, `src/lib/app-meta.test.ts`, `src-tauri/**`

**Interfaces:** Produces `APP_META` and working `pnpm test`, `pnpm check`, `pnpm build`, and `cargo test` commands.

- [ ] Download the official rustup installer, inspect its checksum metadata from the HTTPS response, install the stable minimal toolchain, and verify `rustc --version` and `cargo --version`.
- [ ] Scaffold with `pnpm dlx create-tauri-app@4.6.2 . --manager pnpm --template svelte-ts --identifier io.tracelab.desktop --tauri-version 2 --yes --force`.
- [ ] Add Vitest, jsdom, Testing Library, `test`, `test:watch`, and `check` scripts.
- [ ] Write `app-meta.test.ts` expecting `{ name: "TraceLab", bundleIdentifier: "io.tracelab.desktop" }` and run it to observe the missing-module failure.
- [ ] Implement the frozen `APP_META` value, set `minimumSystemVersion` to `14.0`, and use `rust-toolchain.toml` with stable, rustfmt, and clippy.
- [ ] Run all frontend and Rust scaffold checks.
- [ ] Commit `build: bootstrap TraceLab Tauri workspace`.

### Task 2: Provider Event Contract and Session State Machine

**Files:** `src-tauri/src/domain/{mod,event,session}.rs`, `src-tauri/tests/domain_contract.rs`

**Interfaces:** Produces `ProviderEvent`, `EvidenceClass`, `ParseStatus`, `RawArtifactRef`, `SessionCoordinator`, `SessionStatus`, `ProviderState`, and `SessionError`.

- [ ] Write failing serde round-trip tests for a schema-versioned event with provider ID/version, session UUID, sequence, source/host/monotonic nanoseconds, device/process identity, evidence class, kind, JSON payload, raw reference, and parse status.
- [ ] Write failing state tests for `Created -> Preparing -> Capturing -> Degraded -> Stopping -> Finalizing -> Ready` and rejection of `Created -> Capturing`.
- [ ] Implement snake-case serde enums and the event struct.
- [ ] Implement the guarded state machine with provider registration and explicit degraded/failed states.
- [ ] Run `cargo test --test domain_contract`, rustfmt, and clippy with warnings denied.
- [ ] Commit `feat: define capture events and session lifecycle`.

### Task 3: Crash-Safe Session Store and SQLite Index

**Files:** `src-tauri/migrations/0001_events.sql`, `src-tauri/src/store/{mod,session_store,event_index}.rs`, `src-tauri/tests/session_store.rs`

**Interfaces:** Produces `SessionStore::create/append/finalize` and `EventIndex::open/insert/page`.

- [ ] Write a failing test that appends one event, finalizes, verifies atomic promotion from `.partial`, checks `manifest.json`, and verifies `checksums.sha256`.
- [ ] Write a failing pagination test that inserts five events and expects sequences 2 and 3 at offset 2, limit 2.
- [ ] Add a WAL SQLite migration with primary key `(session_id, provider_id, sequence)` and a stable timeline index.
- [ ] Implement append-only JSONL with flush, `sync_all`, atomic rename, SHA-256, owner-only session directories, and a rebuildable SQLite index.
- [ ] Run storage tests, rustfmt, and clippy.
- [ ] Commit `feat: add crash-safe session storage`.

### Task 4: Python Provider and Cross-Language IPC

**Files:** `sidecars/ios-provider/pyproject.toml`, `sidecars/ios-provider/src/tracelab_ios_provider/{protocol,fake,frida_provider,cli}.py`, Python tests, `src-tauri/src/provider/{mod,codec,supervisor}.rs`, `src-tauri/tests/provider_protocol.rs`

**Interfaces:** Produces big-endian length-prefixed MessagePack framing, deterministic fake events, structured Frida USB preflight, Rust frame decoding, and provider supervision.

- [ ] Write failing Python tests for a four-byte big-endian frame prefix, contiguous fake sequences, and dependency-injected Frida USB discovery.
- [ ] Implement `send_frame()`, deterministic event generation, and `usb_preflight()` returning either device metadata or a structured error.
- [ ] Implement CLI subcommands `fake` and `frida-preflight`.
- [ ] Write a failing Rust async test that sends a MessagePack `ProviderEvent` through `tokio::io::duplex` and expects an identical decoded event.
- [ ] Implement a 16 MiB-bounded Rust frame decoder and a Unix-socket supervisor that launches the uv sidecar with `kill_on_drop`.
- [ ] Run Python and Rust protocol suites.
- [ ] Commit `feat: add versioned iOS provider protocol`.

### Task 5: End-to-End Fake Capture

**Files:** `src-tauri/src/capture.rs`, `src-tauri/tests/fake_capture.rs`

**Interfaces:** Produces `run_fake_capture(root, provider_project, count) -> CaptureSummary`.

- [ ] Write a failing integration test requesting nine sidecar events and asserting nine JSONL records, nine SQLite records, sequences 0 through 8, manifest, and checksums.
- [ ] Implement orchestration: create coordinator/store/index, bind a private Unix socket, run the sidecar, validate session UUID and contiguous sequences, append before indexing, stop/finalize, and remove the socket.
- [ ] Add an explicit `CaptureGap` record before failure whenever a non-contiguous sequence is received.
- [ ] Run integration tests and clippy.
- [ ] Commit `feat: supervise providers and finalize captures`.

### Task 6: Typed Tauri Commands

**Files:** `src-tauri/src/{app_state,commands}.rs`, `src/lib/{contracts,api}.ts`, `src/lib/api.test.ts`, `src-tauri/capabilities/default.json`

**Interfaces:** Produces `create_demo_session`, `page_events`, and `frida_preflight` commands plus typed frontend wrappers.

- [ ] Write a failing Vitest test showing `createDemoSession(30)` invokes `create_demo_session` with `{ count: 30 }`.
- [ ] Define camel-case DTOs for events, pages, capture summaries, health, and Frida preflight.
- [ ] Implement a single-active-capture guard, count bounds 1–10,000, app-data session path, provider project path, paging limit capped at 500, and exact sidecar error propagation.
- [ ] Register commands with only `core:default` capability.
- [ ] Run TypeScript, Rust, and capability-schema checks.
- [ ] Commit `feat: expose capture and preflight commands`.

### Task 7: Minimal High-Density Timeline UI

**Files:** `src/lib/components/{CaptureToolbar,HealthStrip,Timeline,EventInspector}.svelte`, `src/lib/components/Timeline.test.ts`, `src/{App.svelte,app.css}`

**Interfaces:** Consumes the typed API and produces one window with capture controls, provider health, paged rows, and raw inspection.

- [ ] Write a failing component test expecting `OBSERVED`, `FixtureApp`, `network.request`, and `#4` from one event.
- [ ] Implement focused components with callback props, keyboard-accessible rows, explicit evidence badges, and a raw JSON inspector.
- [ ] Implement state for idle/capturing/ready/error, Frida preflight, demo capture, first 200 events, selection, and visible errors.
- [ ] Style a 44 px toolbar, three-column workspace, dense 12–14 px data typography, high-contrast status colors, and a persistent health strip.
- [ ] Run Vitest, Svelte check, Vite build, and a Tauri dev smoke test.
- [ ] Commit `feat: add TraceLab capture timeline`.

### Task 8: Application Bundle and Evidence

**Files:** `README.md`, `docs/testing/foundation-verification.md`, `.gitignore`

**Interfaces:** Produces a locally signed `TraceLab.app` and repeatable verification record.

- [ ] Document macOS 14+, Apple Silicon, Xcode, Node/pnpm, Rust, Python/uv, demo capture, Frida preflight, session layout, and deferred milestones.
- [ ] Run frozen dependency installation, all TypeScript/Python/Rust tests, rustfmt check, clippy, and frontend build.
- [ ] Build with `pnpm tauri build --debug --bundles app`.
- [ ] Verify `src-tauri/target/debug/bundle/macos/TraceLab.app` using `codesign --verify --deep --strict`.
- [ ] Record tool versions, pass counts, app path, Frida preflight with redacted device ID, one session UUID, event count, SQLite count, and checksum verification.
- [ ] Run `git diff --check`, verify generated artifacts are ignored, and commit `docs: record TraceLab foundation verification`.

## Completion Gate

- [ ] `TraceLab.app` launches on the target Mac.
- [ ] The fake provider crosses the same Unix socket/MessagePack boundary reserved for real providers.
- [ ] Every event exists in append-only JSONL and SQLite.
- [ ] Sequence gaps are explicit and visible.
- [ ] Frida preflight reports the connected USB iPhone or a structured local error.
- [ ] The UI displays evidence class, process, kind, payload, capture health, and errors.
- [ ] All Rust, Python, and TypeScript tests pass.
- [ ] The app bundle passes code-signature verification.
- [ ] The repository ends with a clean Git status.

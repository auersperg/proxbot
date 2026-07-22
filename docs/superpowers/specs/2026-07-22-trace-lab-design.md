# proxbot — Design Specification

**Date:** 2026-07-22  
**Status:** Ready for user review  
**Target:** macOS 14+ on Apple Silicon  
**Device scope:** A paired, USB-connected, non-jailbroken iPhone  

## 1. Purpose

proxbot is a minimal desktop application for high-fidelity observation and analysis of traffic produced by an iOS application. It combines passive USB packet capture, iOS process and log metadata, an optional HTTP(S) proxy, and an instrumented laboratory build into one crash-recoverable session.

The primary workflow is:

1. Connect an iPhone by USB.
2. Select an installed application or import an `.ipa`/`.app` for a separate laboratory build.
3. Start one synchronized capture session.
4. Reproduce an application action, including an embedded-wallet or Solana transaction flow.
5. Stop and finalize the session.
6. Inspect the correlated timeline and export PCAP, HAR, JSONL, and a sanitized analysis bundle.

The product must preserve raw evidence before interpretation. It must distinguish data directly observed on the device from data obtained through an explicit enrichment query or inferred by correlation.

## 2. Design Principles

### 2.1 Loss visibility instead of silent loss

Every provider reports received, persisted, malformed, and dropped event counts. Capture gaps are first-class events with source, reason, time range, and estimated impact. A session is labeled `Complete`, `Complete with warnings`, `Incomplete`, or `Corrupted` during finalization.

### 2.2 Raw-first storage

Raw PCAP, append-only provider logs, and content-addressed bodies are the durable sources of truth. SQLite is a rebuildable query index. New analyzers can be applied to an old session without repeating the transaction.

### 2.3 Evidence classes

Every displayed fact is labeled as one of:

- `OBSERVED`: emitted by the iPhone, selected application, proxy, or capture provider;
- `ENRICHED`: retrieved by an explicit proxbot analysis request, such as a Solana RPC status lookup;
- `INFERRED`: produced by correlation, always with confidence and supporting evidence.

### 2.4 Isolation

Capture, instrumentation, storage, analysis, and UI are independently replaceable components with versioned interfaces. A failed analyzer must not interrupt raw capture. A failed optional provider moves the session to `Degraded` while healthy providers continue.

### 2.5 Local and inspectable operation

The application has no telemetry and no cloud dependency. External enrichment is disabled until the user invokes it. Any enrichment request is recorded as proxbot-generated traffic and never presented as traffic from the observed application.

## 3. Supported Scope

### 3.1 MVP includes

- macOS 14+ on Apple Silicon;
- USB discovery, pairing state, and iOS device metadata;
- iOS 17+ CoreDevice/RemoteXPC tunnel handling where required;
- USB `pcapd` capture with process metadata;
- iOS `syslog`/`oslog` collection;
- process and application lifecycle events;
- optional HTTP/1.1, HTTP/2, WebSocket, and TLS proxy capture;
- preparation and installation of a separately signed laboratory build;
- selectable pinned-TLS observation, plaintext capture, and lab-allow profiles;
- a loss-aware unified timeline and flow inspector;
- DNS, TCP/UDP, TLS, HTTP, WebSocket, JSON, JSON-RPC, and Solana analyzers;
- PCAP, HAR, JSONL, session bundle, and sanitized bundle exports;
- capture health, crash recovery, checksums, and reproducible re-indexing.

### 3.2 Deferred

- Android;
- Windows and Linux builds;
- Intel Mac optimization;
- direct attachment to arbitrary installed production applications;
- jailbreak-specific providers;
- a managed iOS Network Extension companion;
- remote synchronization or team collaboration;
- breakpoint rewriting, map-local, and traffic mutation tools;
- automatic concealment of instrumentation;
- protocol-specific decoders beyond the MVP list;
- claims of QUIC payload decryption when neither session secrets nor application plaintext are available.

## 4. System Architecture

proxbot uses a hybrid architecture.

```text
Svelte 5 + TypeScript UI
          |
          | typed Tauri commands and paged queries
          v
Tauri 2 / Rust Application Core
          |
          +-- Session Coordinator
          +-- Provider Supervisor
          +-- Event Normalizer
          +-- Lossless Session Store
          +-- Correlation Engine
          +-- Analysis Scheduler
          +-- Export and Sanitization
          |
          +-- iOS Device Sidecar (Python/pymobiledevice3)
          +-- Proxy Provider
          +-- Instrumentation Provider
          +-- Optional Chain Monitor
```

Tauri owns application lifecycle, minimum capabilities, local file access, native dialogs, secret storage, process supervision, and packaging. Rust owns session state, durable storage, normalized schemas, analysis scheduling, and UI query APIs. The UI never receives an unbounded stream of raw packets.

The iOS provider is a bundled sidecar based on `pymobiledevice3`, isolated behind a versioned provider contract. It supplies device discovery, tunnel management, PCAP, logs, application management, and process information. Packaging must include the required license notices and source-availability obligations for every redistributed component.

## 5. Component Contracts

### 5.1 Session Coordinator

The coordinator implements this state machine:

```text
Created -> Preparing -> Capturing -> Stopping -> Finalizing -> Ready
                          |              |
                          +-> Degraded <-+
Any non-terminal state -> Recovering -> Finalizing or Corrupted
```

Only the coordinator changes session state. It starts providers in dependency order, publishes health, records explicit user markers, initiates a grace period at stop, finalizes checksums, and generates the session report.

### 5.2 Provider contract

Every provider implements:

```text
probe -> prepare -> start -> health -> stop -> finalize
```

Every event includes:

- schema version;
- provider ID and provider version;
- session UUID;
- source sequence number;
- source timestamp;
- host receive timestamp;
- monotonic timestamp when available;
- device ID;
- process identity when available;
- evidence class;
- payload type;
- raw artifact reference;
- parse status.

Provider control messages use a versioned request/response protocol. High-rate metadata uses length-prefixed MessagePack frames over a Unix domain socket. Raw packet bytes and large bodies are written directly into provider-owned temporary files in the session directory, then atomically handed to the core. A sidecar must spool locally when the IPC consumer is backpressured and report any spool overflow.

### 5.3 Required providers

#### Device Provider

Discovers the USB iPhone; reports pairing, trust, Developer Mode, DDI, tunnel, model, iOS version, UDID, installed applications, and available services.

#### USB PCAP Provider

Records raw packets before decoding. For each packet it retains the source timestamp, host timestamp, interface, direction, PID, process name, captured length, original length, sequence number, and raw offset.

#### System Log Provider

Streams iOS logs into compressed append-only JSONL. It preserves original lines and attaches parsed process, subsystem, category, and level fields without replacing the original representation.

#### Process Provider

Records application launch, PID changes, child processes, termination, and available crash reports. It provides the process map used to correlate PCAP packets and instrumentation events.

#### Proxy Provider

Captures HTTP CONNECT, HTTP/1.1, HTTP/2, WebSocket, and TLS metadata when traffic is actually routed through it. Proxy absence is never interpreted as network absence because USB PCAP remains independent.

#### Instrumentation Provider

Connects to the selected laboratory build, starts instrumentation before application resume, receives trust, networking, plaintext, socket, and wallet events, and flushes them during finalization.

#### Clock Provider

Measures and periodically updates clock offsets between the Mac, iPhone, provider runtimes, and instrumentation runtime. The normalized timeline retains both original and adjusted timestamps.

#### Chain Monitor

Performs optional, explicit Solana RPC enrichment after a transaction signature is known. Its endpoint, request, response, latency, and time are marked `ENRICHED` and stored separately from device observations.

## 6. Capture Lifecycle

### 6.1 Preflight

Before capture, proxbot:

1. verifies device connectivity and pairing;
2. selects or establishes the required iOS tunnel;
3. verifies capture, log, and process services;
4. checks free disk space and write permissions;
5. records tool and provider versions;
6. measures initial clock offsets;
7. validates the selected application or laboratory build;
8. creates a session directory and initial manifest;
9. prepares every selected provider;
10. presents a compact readiness summary.

### 6.2 Start order

1. Session Store
2. Clock Provider
3. USB PCAP Provider
4. Process Provider
5. System Log Provider
6. Proxy Provider
7. Instrumentation Provider
8. Selected application launch
9. Analysis scheduler
10. Optional Chain Monitor listener

The application launches only after packet, process, log, and instrumentation channels are ready or explicitly degraded.

### 6.3 Stop order

1. record the user stop marker;
2. wait a configurable grace period for delayed responses and status polling;
3. flush instrumentation;
4. flush logs and proxy flows;
5. record the final process snapshot;
6. stop PCAP last;
7. atomically close append-only artifacts;
8. run final analyzers and index updates;
9. compute checksums;
10. write the final manifest and health report.

## 7. Laboratory Build and TLS Instrumentation

### 7.1 Build preparation

proxbot accepts an `.ipa`, `.app`, or the user's debug/archive build. It never overwrites the original input. It computes the input SHA-256, inventories Mach-O architectures, bundle metadata, frameworks, extensions, entitlements, provisioning profile, and current signatures, then works in a new directory.

The build pipeline embeds the instrumentation runtime, its configuration, and the selected observation modules. It signs nested code from the inside out, signs the main application last, verifies every signature, installs a separate build, and records input/output hashes and the exact transformation manifest.

The preferred separate bundle identifier uses a `.capturelab` suffix. Preserving the original bundle identifier is supported only when the selected provisioning profile and entitlements are compatible. proxbot warns when changes to keychain groups, associated domains, push notification entitlements, or Sign in with Apple can change application behavior.

### 7.2 Instrumentation profiles

#### Observe

Records trust APIs, hostnames, certificate chains, original trust results, networking stack identity, stack fingerprints, and related request metadata without changing the trust result.

#### Capture

Captures available request and response plaintext plus TLS/session metadata without changing trust decisions.

#### Lab Allow

For the selected laboratory build, records the original trust result and then allows supported trust-validation paths to continue for the test session. Each modified decision retains hostname, chain, original result, selected profile, timestamp, PID/TID, and stack fingerprint.

#### Key Material and Plaintext

When session secrets are available, they are encrypted at rest and used to decrypt the corresponding PCAP flow. Otherwise, application plaintext is correlated with the encrypted flow. The UI must use distinct labels:

- `PCAP decrypted with session secrets`;
- `Application plaintext correlated with encrypted flow`.

proxbot must never describe correlated application plaintext as cryptographic decryption of the packet capture.

### 7.3 Launch on a non-jailbroken device

The instrumentation provider launches the debuggable laboratory build under the required developer/debug service, establishes instrumentation before application resume, installs the selected profile, then resumes the application. If a required hook is unavailable, the provider reports its exact coverage rather than silently omitting the category.

## 8. Storage Format

Each session is self-contained:

```text
SESSION/
|-- manifest.json
|-- capture/
|   |-- device-raw.pcap
|   |-- packets.jsonl.zst
|   `-- process-map.jsonl.zst
|-- logs/
|   |-- syslog.jsonl.zst
|   `-- instrumentation.jsonl.zst
|-- proxy/
|   |-- flows.jsonl.zst
|   `-- bodies/
|-- objects/
|   `-- sha256/
|-- database/
|   `-- session.sqlite
|-- sensitive/
|   `-- encrypted-secrets.bin
|-- reports/
|-- exports/
`-- checksums.sha256
```

Append-only artifacts use a `.partial` suffix until they are flushed and atomically renamed. SQLite uses WAL during capture and is checkpointed during finalization. Large bodies are content-addressed and deduplicated. `checksums.sha256` covers every finalized artifact except mutable export output.

The manifest records device and host metadata, capture configuration, selected app identity, hashes, provider versions, clock models, health counters, gaps, analysis versions, redaction policy, and session status.

## 9. Normalization and Correlation

The normalization layer derives flow, request, and transaction records without mutating original provider events.

Network correlation considers:

- PID and process lifecycle;
- protocol and 5-tuple;
- socket/file-descriptor metadata;
- source and normalized time ranges;
- request IDs;
- direction and byte counts;
- hostname and TLS metadata;
- stack fingerprints.

Each inferred relationship stores a confidence score, matched features, conflicting features, and the analyzer version. Low-confidence candidates remain inspectable and are not silently collapsed into one flow.

## 10. Solana and Embedded-Wallet Analysis

The Solana analyzer understands legacy and versioned messages, recent blockhash, fee payer, account keys, address lookup tables, program IDs, instructions, compute-budget instructions, token accounts, mint addresses, amounts, and signatures.

It constructs an explicit transaction trace:

```text
User action
-> wallet method
-> unsigned transaction
-> signTransaction request
-> signed transaction response
-> possible send/broadcast request
-> transaction signature
-> optional enriched chain status
```

Signing and broadcasting are separate states. Supported conclusions include:

- `Signed locally or by embedded wallet runtime; broadcast observed on device`;
- `Signed by wallet service; broadcast not observed on device`;
- `Signed payload passed to backend; downstream broadcast origin absent from device traffic`;
- `Transaction signature enriched through proxbot RPC lookup`.

The inspector displays the evidence supporting each conclusion. It does not infer a direct Solana RPC call merely because a transaction later appears on-chain.

## 11. User Experience

proxbot uses one primary window with four stable regions.

### 11.1 Toolbar

- device selector;
- application/laboratory-build selector;
- capture profile;
- Start, Marker, and Stop controls;
- global health indicator;
- session elapsed time and written size.

### 11.2 Left sidebar

- saved sessions;
- provider status;
- application/process tree;
- quick filters for network, logs, trust, wallet, and Solana events.

### 11.3 Center timeline

A virtualized, paged timeline supports millions of events. Rows display normalized time, source badges, process, category, endpoint/operation, size or duration, evidence class, and warning state. Users can filter by text, process, hostname, protocol, evidence class, transaction signature, account, program ID, source, and time range.

### 11.4 Right inspector

The inspector provides Overview, Request, Response, TLS, Packets, Process, Stack, Wallet, Solana, Correlation, Raw, and Notes tabs as applicable. Raw views always identify their source artifact and offset.

### 11.5 Bottom health strip

Shows provider status, received/persisted/dropped counts, queue depth, write throughput, free space, clock drift, reconnect count, and last-event age. Clicking a warning jumps to the affected time interval.

### 11.6 Analysis ergonomics

Users can add named markers during reproduction, pin events, compare two flows, copy a reproducible event reference, and generate a compact analysis bundle suitable for later Codex inspection. The bundle includes schemas and a machine-readable session summary so analysis does not depend on screenshots.

## 12. Security and Privacy

- No telemetry or automatic upload.
- Tauri capabilities are deny-by-default and limited per window.
- Sidecars are bundled, hashed, and launched only by the provider supervisor.
- Capture directories use owner-only permissions.
- A per-session data key encrypts TLS secrets and designated sensitive artifacts with authenticated encryption; the wrapping key is stored in macOS Keychain.
- Access tokens, refresh tokens, cookies, authorization headers, seed phrases, private keys, and configured sensitive JSON fields are redacted in the default UI and all sanitized exports.
- Raw values remain available only in the protected raw session when capture settings explicitly retain them.
- Private keys and seed phrases are never written to logs, generated source, command history, or reports.
- Clipboard copying of a revealed secret requires an explicit reveal action and produces a local audit event.
- Export offers `Raw`, `Sanitized`, and `Metadata only` modes with an exact file manifest before writing.

## 13. Error Handling and Recovery

### 13.1 Provider failure

The supervisor restarts a reconnectable provider with bounded exponential backoff. It records the last sequence number, restart attempt, gap interval, and recovery result. Non-reconnectable providers remain failed while other sources continue.

### 13.2 Disk pressure

The health strip warns at configurable thresholds. At the critical threshold, proxbot stops capture in controlled order, flushes artifacts, and finalizes the session as `Incomplete` rather than risking filesystem corruption.

### 13.3 Device disconnect

The coordinator records disconnect time, keeps host-side proxy data running for a short recovery window, and reconnects to the same UDID when it returns. A new device never silently replaces the selected one.

### 13.4 Application crash

Capture continues for the grace period, the crash report is collected when available, and the session links it to the process and final network events.

### 13.5 Host or application crash

On restart, proxbot scans `.partial` sessions, validates append-only frames to the last complete record, rebuilds the SQLite index, records the interrupted interval, and finalizes the session as recovered or corrupted.

### 13.6 Laboratory-build failure

Every transformation step is transactional. A failed signature or installation leaves the original artifact and installed original application untouched. proxbot retains the transformation manifest and exact failing command output for diagnosis.

## 14. Testing Strategy

### 14.1 Unit tests

- session state transitions;
- event schema round trips;
- clock normalization;
- sequence-gap detection;
- storage atomicity;
- redaction rules;
- Solana transaction decoding;
- evidence classification;
- correlation scoring;
- export manifests and checksums.

### 14.2 Property and fuzz tests

- malformed MessagePack frames;
- truncated PCAP and JSONL;
- arbitrary HTTP headers and bodies;
- corrupted Solana messages;
- Unicode and binary payloads;
- redaction invariants that prevent configured secret classes from entering sanitized exports.

### 14.3 Golden fixtures

Versioned fixtures cover DNS, TCP, TLS, HTTP/1.1, HTTP/2, WebSocket, pinned-TLS application events, Privy-style wallet calls, legacy Solana transactions, v0 messages, address lookup tables, failed transactions, and backend-mediated broadcast.

Each golden session has expected normalized events, correlations, health status, exports, and checksum manifest.

### 14.4 Integration tests

A deterministic fake provider suite simulates normal capture, backpressure, sequence gaps, reconnects, clock drift, malformed frames, disk pressure, and abrupt process death. Integration tests run without an iPhone.

### 14.5 Hardware validation

A dedicated laboratory iOS fixture application produces known HTTP/1.1, HTTP/2, WebSocket, TLS-pinned, binary-body, large-body, background, and Solana-signing flows. Hardware tests compare application-side ground truth against USB PCAP, logs, proxy, instrumentation, timeline, and exports.

### 14.6 Performance acceptance

On a representative Apple Silicon Mac, the MVP must demonstrate:

- a four-hour capture without core-induced event loss under the fixture workload;
- sustained ingestion of 50,000 normalized metadata events per second for ten minutes;
- recovery of a deliberately interrupted session to its last complete frame;
- interactive paged navigation in a session containing at least ten million events;
- no raw body transfer through the Tauri UI event channel;
- bounded queues and visible drop accounting during forced overload;
- deterministic re-indexing that reproduces normalized record counts and transaction traces.

Performance results, hardware model, operating-system version, fixture version, and observed limits are saved as release artifacts.

## 15. Exports

### 15.1 Raw session bundle

Contains the complete self-contained session, encrypted sensitive area, schemas, manifest, and checksums.

### 15.2 Sanitized analysis bundle

Contains normalized events, selected raw excerpts, transaction traces, provider health, schemas, and a redaction report. It omits encrypted secrets and replaces configured identifiers consistently so relationships remain analyzable.

### 15.3 Standard exports

- PCAP for packet tools;
- HAR for supported HTTP flows;
- JSONL for streaming analysis;
- SQLite snapshot for structured queries;
- Markdown and JSON session summaries;
- TLS key log only through an explicit protected export action when captured.

Every export records the source session UUID, source checksum set, analyzer versions, filter, time range, evidence classes, redaction mode, creation time, and output checksums.

## 16. Rollback and Cleanup

proxbot records every temporary host and device change. Cleanup can:

- stop tunnels and sidecars;
- restore proxy configuration managed by proxbot;
- remove the proxbot CA installed through its workflow;
- uninstall the separate laboratory build;
- delete its temporary build directory;
- retain or securely delete session secrets;
- preserve the original application artifact and installed original application.

Cleanup results are written to the session manifest. Confirmed on-chain transactions are immutable; for Solana, rollback means a protocol-supported compensating transaction or application-specific recovery action, never deletion of confirmed history.

## 17. Implementation Boundaries

The first implementation plan will be split into sequential milestones:

1. repository, Tauri shell, schemas, and fake providers;
2. crash-safe session store and provider supervision;
3. iOS discovery, tunnel, PCAP, logs, and process capture;
4. timeline, health strip, filtering, and inspector;
5. proxy provider and standard protocol analyzers;
6. laboratory-build pipeline and instrumentation profiles;
7. Solana and embedded-wallet analysis;
8. exports, sanitization, recovery, performance testing, and packaging.

Each milestone must be independently testable and leave a usable artifact. Hardware-dependent behavior is abstracted behind provider interfaces and validated both with deterministic fixtures and a real paired iPhone.

## 18. Acceptance Criteria

The MVP is accepted when a user can connect the paired iPhone, select the laboratory application, start a synchronized session, reproduce a pinned-TLS embedded-wallet transaction, stop capture, and inspect a timeline that:

- retains raw PCAP and all provider artifacts;
- displays provider coverage and any gaps;
- correlates encrypted flows with proxy or application plaintext without mislabeling the evidence;
- separates signing from broadcasting;
- decodes the signed Solana transaction;
- distinguishes device-observed traffic from proxbot enrichment;
- survives provider and application failures without losing already persisted data;
- exports verified raw and sanitized bundles that can be re-indexed and analyzed later.

## 19. Primary Technical References

- [Tauri 2 documentation](https://v2.tauri.app/)
- [Tauri external binaries and sidecars](https://v2.tauri.app/develop/sidecar/)
- [Tauri capabilities](https://v2.tauri.app/security/capabilities/)
- [pymobiledevice3](https://github.com/doronz88/pymobiledevice3)
- [Frida iOS operation](https://frida.re/docs/ios/)
- [Frida Gadget](https://frida.re/docs/gadget/)

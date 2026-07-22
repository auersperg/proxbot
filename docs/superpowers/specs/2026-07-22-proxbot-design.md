# proxbot — Design Specification

**Date:** 2026-07-22
**Status:** Approved
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
React 19 + TypeScript 7 UI / Vite 8 / Bun 1.3
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

### 4.1 Frontend and JavaScript toolchain

The desktop interface uses React 19, React DOM 19, TypeScript 7, Vite 8, and Bun 1.3. Bun is the only JavaScript package manager and script runner used by the repository. The repository contains exactly one JavaScript lockfile, `bun.lock`, and no alternative package-manager artifacts. Tauri invokes `bun run dev` and `bun run build`; Vite produces `dist`, which Tauri consumes as `../dist`.

The frontend is a client-only application. It has no SSR, frontend router, Redux-style global store, UI component framework, or parallel legacy frontend. Local component state and focused reducers manage presentation state. Rust remains the source of truth for sessions, queries, filtering, sorting, paging, artifact access, and analysis.

The Vite development server uses a fixed port, fails if that port is occupied, preserves Rust diagnostics, and respects `TAURI_DEV_HOST`. Production targets match the WebView versions supported by Tauri. Debug builds retain source maps and readable output; release builds are minified.

The only permitted general-purpose frontend dependency beyond React and the Tauri APIs is a focused virtualization primitive for lists and rows. New dependencies require a demonstrated reduction in code or a measured performance benefit.

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
- event UUID and parent event UUID when present;
- source sequence number;
- source timestamp;
- host receive timestamp;
- monotonic timestamp when available;
- device ID;
- application ID;
- process identity when available;
- thread identity when available;
- evidence class;
- payload type;
- raw artifact reference;
- raw artifact byte offset, captured length, original length, and SHA-256;
- network direction, connection ID, stream ID, and request ID when present;
- receive and persistence sequence numbers;
- provider queue depth and cumulative drop count;
- correlation confidence and analyzer version for inferred relationships;
- parse status.

Network records additionally retain interface, transport, source and destination addresses and ports, DNS query and answer data, TCP sequence/reassembly information, TLS version/cipher/SNI/ALPN/certificate fingerprints, HTTP version and original header order, body encoding and exact body location, HTTP/2 stream identity, WebSocket frame boundaries, request timing, process correlation, and the explicit reason for every incomplete field. A field that was not observed is distinct from a field that was observed empty.

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

proxbot uses one dense, dark, primary window inspired by the efficient analysis layout of Proxyman without copying its branding or decorative chrome. Information density, immediate selection feedback, keyboard navigation, and exact evidence inspection take priority over animations and ornamental UI. The window has a toolbar, endpoint sidebar, request table, split request/response inspector, and health strip. Every splitter is resizable and its position persists locally.

```text
+------------------------------------------------------------------------------+
| Device | App | Profile | Start/Pause/Marker/Stop | Filter | Health | Time   |
+----------------------+-------------------------------------------------------+
| Device               | Request table                                         |
| +-- Domains          | # Method Host/IP Path Status Protocol Time Size Warn  |
| |   +-- example.com  |                                                       |
| +-- IP addresses     |                                                       |
|     +-- 192.0.2.1    |                                                       |
+----------------------+--------------------------+----------------------------+
| Sessions/providers   | RAW Request              | RAW Response               |
+----------------------+--------------------------+----------------------------+
| received | persisted | malformed | dropped | queue | throughput | last event |
+------------------------------------------------------------------------------+
```

### 11.1 Toolbar

The toolbar contains only the selected device, selected application or laboratory build, capture profile, Start/Pause/Marker/Stop controls, global filter, session health, elapsed time, and written size. A destructive or state-changing action has one unambiguous control and a visible disabled reason. Capture state remains visible while any inspector has focus.

### 11.2 Device and endpoint sidebar

The primary hierarchy is the selected device followed by `Domains` and `IP addresses`. Each endpoint shows a matching request count. Selecting the device shows all matching requests; selecting a domain or IP applies an indexed query to the center table. Domain identity and IP identity remain separate even when correlation links them.

For a domain, proxbot retains the original and normalized names, DNS answers, CNAME chain, SNI, certificate names, and related IP addresses. For an IP, it retains address family, port, transport, correlated domain names, and explicitly labeled enrichment when ASN or organization information is requested. Saved sessions, provider state, application/process filters, and saved filters occupy a compact secondary section below the endpoint tree.

The endpoint tree is virtualized, keyboard navigable, incrementally updated, and backed by Rust/SQLite aggregation. React never scans the entire session to calculate endpoint counts.

### 11.3 Request table

The center table is the dominant region. Its columns are sequence, observed time, method or operation, scheme, domain or IP, path, client/device/process, status, protocol, duration, request bytes, response bytes, TLS state, evidence class, and warning state. Columns are reorderable and resizable; a minimal default set remains legible at the minimum supported window size.

The table combines Rust-side filtering, sorting, stable cursor paging, and row virtualization. Selection is keyed by immutable request or flow identity rather than visible row index. Live updates arrive in bounded batches and do not reorder an actively inspected selection without an explicit user action. Scrolling does not trigger decoding or analysis.

Filters cover free text, device, application, process, hostname, IP, protocol, method, status, evidence class, transaction signature, account, program ID, source, warning type, and time range. The table visibly distinguishes an absent response, an incomplete body, a capture gap, a parse failure, and a request still in flight.

### 11.4 Split RAW request and RAW response inspector

Selecting a request opens two persistent panes beneath the table: `RAW Request` on the left and `RAW Response` on the right. Each pane has contextual `Raw`, `Headers`, `Body`, `TLS`, `Timing`, `Packets`, `Process`, `Stack`, `Wallet/Solana`, and `Correlation` views when corresponding evidence exists. `Raw` is the default.

The request pane preserves the request line or HTTP/2 pseudo-headers, original header order and casing, repeated headers, exact empty-line boundary, body bytes, trailers, content encoding, and known chunk or frame boundaries. The response pane preserves the status line, original headers, body bytes, trailers, timing, TLS/connection metadata, and known chunk or frame boundaries. Binary data has an exact hex view beside decoded text. Invalid text decoding is reported and never replaces the original bytes.

Every raw view identifies evidence class, provider, artifact path, byte offset, captured length, original length, hash, truncation state, parse state, and whether the display is original bytes or a clearly labeled reconstruction. Normalized fields are never presented as byte-exact raw traffic.

Bodies are content-addressed artifacts. Initial selection loads metadata and a bounded preview. Additional byte ranges are fetched on demand through typed Tauri commands; full bodies and unbounded packet arrays never cross the Tauri event channel. Body search runs in Rust and returns match ranges. Copy operations preserve exact bytes when representable and otherwise provide an explicit binary export.

### 11.5 Bottom health strip

The persistent health strip shows provider state, received, persisted, malformed and dropped counts, queue depth, write throughput, free space, clock drift, reconnect count, and last-event age. Healthy, warning, degraded, and failed states differ by text and icon as well as color. Clicking a counter opens the affected source and time interval. No provider loss is summarized away.

### 11.6 Sensitive-data presentation

The raw artifact is immutable evidence. The default interface applies a reversible visual mask to configured secret classes without changing stored bytes or hashes. The user can reveal one value locally, copy an exact or sanitized variant, or use protected and sanitized exports as separate operations. The interface always indicates masking, reconstruction, truncation, and sanitization; these states are never implicit.

### 11.7 Analysis ergonomics

Users can navigate all major regions by keyboard, add named markers, pin events, compare two flows, copy a reproducible event reference, and generate a compact analysis bundle for later Codex inspection. The bundle includes schemas, filters, analyzer versions, evidence references, provider health, gaps, and a machine-readable session summary so analysis does not depend on screenshots.

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
- React endpoint-tree selection and count rendering;
- request-table stable selection across paging and live batches;
- raw request/response provenance, truncation, masking, and reconstruction labels;
- bounded body-preview and range-loading behavior;
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

A deterministic fake provider suite simulates normal capture, backpressure, sequence gaps, reconnects, clock drift, malformed frames, disk pressure, and abrupt process death. Integration tests run without an iPhone. Frontend integration fixtures exercise device/domain/IP filtering, cursor paging, high-rate bounded batches, keyboard selection, independent raw request and response panes, large bodies, binary bodies, absent responses, capture gaps, and secret overlays against typed Tauri command fakes.

### 14.5 Hardware validation

A dedicated laboratory iOS fixture application produces known HTTP/1.1, HTTP/2, WebSocket, TLS-pinned, binary-body, large-body, background, and Solana-signing flows. Hardware tests compare application-side ground truth against USB PCAP, logs, proxy, instrumentation, timeline, and exports.

### 14.6 Performance acceptance

On a representative Apple Silicon Mac, the MVP must demonstrate:

- a four-hour capture without core-induced event loss under the fixture workload;
- sustained ingestion of 50,000 normalized metadata events per second for ten minutes;
- recovery of a deliberately interrupted session to its last complete frame;
- interactive paged navigation in a session containing at least ten million events;
- no unbounded growth of React state while the ten-million-event fixture is browsed or live batches arrive;
- a selected row remains stable through paging, filtering, and bounded live updates;
- initial raw-inspector selection transfers only metadata and a bounded preview, with additional ranges fetched on demand;
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
4. Bun/React/Vite migration and the device/domain/IP sidebar, request table, split raw inspector, and health strip;
5. proxy provider and standard protocol analyzers;
6. laboratory-build pipeline and instrumentation profiles;
7. Solana and embedded-wallet analysis;
8. exports, sanitization, recovery, performance testing, and packaging.

Each milestone must be independently testable and leave a usable artifact. Hardware-dependent behavior is abstracted behind provider interfaces and validated both with deterministic fixtures and a real paired iPhone.

## 18. Acceptance Criteria

The MVP is accepted when a user can connect the paired iPhone, select the laboratory application, start a synchronized session, reproduce a pinned-TLS embedded-wallet transaction, stop capture, and inspect a timeline that:

- runs through the single Bun/React/Vite frontend with no retained legacy frontend or alternative package-manager runtime path;
- presents the selected device, indexed domain/IP tree, paged request table, and simultaneous RAW Request and RAW Response panes in one window;
- shows original request and response bytes with provider, artifact, offset, length, hash, parse, truncation, reconstruction, evidence, and masking state;
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
- [Tauri Vite frontend configuration](https://v2.tauri.app/start/frontend/vite/)
- [Tauri project templates and Bun/React support](https://v2.tauri.app/start/create-project/)
- [Tauri external binaries and sidecars](https://v2.tauri.app/develop/sidecar/)
- [Tauri capabilities](https://v2.tauri.app/security/capabilities/)
- [pymobiledevice3](https://github.com/doronz88/pymobiledevice3)
- [Frida iOS operation](https://frida.re/docs/ios/)
- [Frida Gadget](https://frida.re/docs/gadget/)

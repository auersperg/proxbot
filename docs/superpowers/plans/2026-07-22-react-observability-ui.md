# proxbot React Observability UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Svelte/pnpm frontend with a single Bun/React/Vite interface that presents a device/domain/IP navigator, a high-density request table, simultaneous RAW Request and RAW Response panes, and explicit capture-health evidence.

**Architecture:** Tauri/Rust remains the data boundary. SQLite materializes HTTP exchange rows and endpoint aggregates as provider events are persisted; typed Tauri commands return bounded pages and endpoint summaries. React renders only bounded pages and selected raw previews using focused components, stable request identities, and a single application reducer.

**Tech Stack:** Bun 1.3, React 19, React DOM 19, TypeScript 7, Vite 8, Vitest 4, Testing Library React 16, TanStack React Virtual 3, Tauri 2, Rust 2024, SQLite/rusqlite, Python 3.14/pytest.

## Global Constraints

- Bun is the only JavaScript package manager and script runner; retain exactly one `bun.lock` and remove pnpm/Svelte configuration and source.
- Use one client-only React application with no SSR, router, Redux-style store, UI framework, or parallel legacy frontend.
- Preserve raw provider events before derived exchange rows; SQLite exchange data is a rebuildable query model.
- Keep frontend data bounded: endpoint summaries, one request page, and one selected raw exchange only.
- RAW Request and RAW Response are visible simultaneously and always state evidence, provenance, reconstruction, truncation, masking, artifact offset, length, and hash.
- Never route raw bodies or unbounded event arrays through the Tauri event channel.
- Keep loss counters and incomplete-state reasons visible; do not silently convert absent data to empty data.
- Use TDD for behavior: observe every new behavior test fail for the intended reason before adding production code.
- Preserve existing Rust, Python, packaging, and provider behavior unless a task explicitly extends its contract.

---

## File Structure

```text
index.html                              Vite entry document
src/main.tsx                            React bootstrap
src/App.tsx                             application orchestration and bounded state
src/styles.css                          complete desktop visual system
src/lib/api.ts                          typed Tauri command client
src/lib/contracts.ts                    frontend DTO contracts
src/lib/exchange.ts                     pure formatting helpers
src/lib/fixtures.ts                     deterministic test/demo DTO builders
src/components/Toolbar.tsx              capture and device controls
src/components/EndpointSidebar.tsx      device/domain/IP tree
src/components/RequestTable.tsx         virtualized request grid
src/components/RawInspector.tsx         simultaneous request/response panes
src/components/HealthStrip.tsx          loss and persistence counters
src/components/*.test.tsx               component behavior tests
src/App.test.tsx                        integrated workspace behavior
src-tauri/migrations/0002_exchanges.sql derived exchange query schema
src-tauri/src/store/exchange_index.rs    event-to-exchange materialization and queries
src-tauri/src/commands.rs                bounded endpoint/exchange command DTOs
src-tauri/tests/exchange_index.rs        Rust query/materialization tests
sidecars/ios-provider/.../fake.py        deterministic paired request/response fixtures
```

### Task 1: Bun, React, and Vite foundation

**Files:**
- Create: `index.html`, `src/main.tsx`, `src/App.smoke.test.tsx`
- Modify: `package.json`, `tsconfig.json`, `src-tauri/tauri.conf.json`, `.gitignore`
- Replace: `vite.config.js` with `vite.config.ts`
- Delete: `svelte.config.js`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `src/app.html`, `src/routes/**`, `src/lib/components/*.svelte`
- Generate: `bun.lock`

**Interfaces:** Produces Vite entry `#root`; `bun run dev`, `build`, `check`, `test`, `tauri`, and `tauri:build`.

- [ ] Write `src/App.smoke.test.tsx` first. It imports `App`, renders it, and expects an application landmark named `proxbot`.
- [ ] Replace `package.json` with React 19, TypeScript 7, Vite 8, `@vitejs/plugin-react` 6, Vitest 4, jsdom 29, Testing Library React 16, user-event 14, and TanStack React Virtual 3. Make `tauri:build` execute `bun run build:provider && tauri build`.
- [ ] Run `bun install`, delete legacy package-manager/configuration files, and run `bun test src/App.smoke.test.tsx`; verify it fails because `src/App.tsx` does not exist.
- [ ] Add the minimal `index.html`, `main.tsx`, `App.tsx`, strict React `tsconfig.json`, and official Tauri-oriented `vite.config.ts`: port 1420, `strictPort`, `TAURI_DEV_HOST`, port 1421 HMR, platform targets, debug source maps, and jsdom tests.
- [ ] Set Tauri `beforeDevCommand` to `bun run dev`, `beforeBuildCommand` to `bun run build`, and `frontendDist` to `../dist`.
- [ ] Run `bun test src/App.smoke.test.tsx && bun run check && bun run build`; expect one passing test, zero type errors, and a successful `dist` build.
- [ ] Commit with `git commit -m "build: migrate frontend to Bun React and Vite"`.

### Task 2: Materialized exchange and endpoint query model

**Files:**
- Create: `src-tauri/migrations/0002_exchanges.sql`, `src-tauri/src/store/exchange_index.rs`, `src-tauri/tests/exchange_index.rs`
- Modify: `src-tauri/src/store/mod.rs`, `src-tauri/src/store/event_index.rs`
- Modify: `sidecars/ios-provider/src/proxbot_ios_provider/fake.py`, `sidecars/ios-provider/tests/test_fake.py`

**Interfaces:**
- `EndpointKind::{Domain, Ip}` and `EndpointFilter { kind, value }`.
- `EndpointSummary { kind, value, count }`.
- `RawView { content, media_type, reconstructed, truncated, masked, artifact }`.
- `ExchangeRow { request_id, request_sequence, response_sequence, started_ns, method, scheme, host, ip, path, status, protocol, process_name, duration_ms, request_bytes, response_bytes, tls, evidence, warning, request_raw, response_raw }`.
- `EventIndex::page_exchanges(session_id, query, endpoint, offset, limit)` and `EventIndex::list_endpoints(session_id, query, limit)`.

- [ ] Extend the Python fake-provider test first: request/response fixtures must share `request_id`, include method/URL/IP/protocol, exact CRLF raw text, byte counts, TLS state, and observed evidence. Run the test and observe the expected failure.
- [ ] Implement deterministic paired fixtures across `auth.privy.io`, `api.mainnet-beta.solana.com`, `api.eu.amplitude.com`, and `gateway.icloud.com`, using RFC 5737 IP addresses and mixed statuses/methods.
- [ ] Add Rust tests first for request/response materialization, separate domain/IP counts, endpoint and free-text filters, stable ordering, absent-response warnings, provenance metadata, and the hard 500-row page cap. Run and observe the missing-module failure.
- [ ] Add the `exchanges` migration keyed by `(session_id, request_id)` with session/time, domain, IP, method, status, and warning indexes.
- [ ] Extend `EventIndex::insert` so the immutable event and derived exchange upsert occur in one SQLite transaction. Unknown or invalid fields become explicit warning/null values rather than fabricated defaults.
- [ ] Implement parameterized bounded queries. Cap endpoint summaries at 2,000; escape LIKE wildcards; order exchanges by `started_ns, request_id`.
- [ ] Run the full Python provider suite plus `cargo test --test exchange_index --test fake_capture`; expect all tests to pass.
- [ ] Commit with `git commit -m "feat: materialize bounded HTTP exchange queries"`.

### Task 3: Typed Tauri query commands

**Files:**
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src-tauri/tests/commands_contract.rs`
- Modify: `src/lib/contracts.ts`, `src/lib/api.ts`, `src/lib/api.test.ts`

**Interfaces:**
- Tauri commands: `list_endpoints(sessionId, query, limit)` and `page_exchanges(sessionId, query, endpointKind, endpointValue, offset, limit)`.
- Frontend methods: `api.listEndpoints(sessionId, query, limit)` and `api.pageExchanges(sessionId, filter)`.
- Existing `page_events` remains available for non-network evidence.

- [ ] Add failing Rust tests for endpoint/page limits, camelCase DTO serialization, decimal-string nanoseconds, absent-response preservation, and raw reconstruction metadata.
- [ ] Implement Rust DTOs, validators, UUID/endpoint parsing, bounded database calls, and command registration.
- [ ] Add failing frontend tests asserting exact command names and argument objects.
- [ ] Define exact TypeScript unions/DTOs and implement both API methods without converting nanosecond strings to numbers.
- [ ] Run Rust command-contract and Bun API tests; expect all to pass.
- [ ] Commit with `git commit -m "feat: expose typed endpoint and exchange commands"`.

### Task 4: Endpoint sidebar and request table

**Files:**
- Create: `src/lib/fixtures.ts`, `src/lib/exchange.ts`, `src/lib/exchange.test.ts`
- Create: `src/components/EndpointSidebar.tsx`, `src/components/EndpointSidebar.test.tsx`
- Create: `src/components/RequestTable.tsx`, `src/components/RequestTable.test.tsx`

**Interfaces:**
- `EndpointSidebar({ device, endpoints, selected, onSelect })`.
- `RequestTable({ exchanges, total, selectedId, busy, onSelect, onPage })`.
- `formatObservedTime(ns: string)` uses `BigInt`; `requestKey(exchange)` returns immutable `requestId`.

- [ ] Write failing pure-helper tests for precision-safe timestamps, status/method classes, null response labels, byte formatting, and warnings; implement the minimal exhaustive helpers.
- [ ] Write failing sidebar tests for device identity, separate Domains/IP addresses groups, counts, keyboard activation, and exact filter callbacks; implement the semantic virtualizable tree without client-side aggregation.
- [ ] Write failing table tests for diagnostic columns, stable selection, absent response, evidence/warning labels, keyboard navigation, and page callbacks.
- [ ] Implement the table with TanStack Virtual, fixed row estimates, overscan, an external header, stable keys, and deterministic accessible labels.
- [ ] Run the helper/sidebar/table tests and eliminate React act warnings.
- [ ] Commit with `git commit -m "feat: add endpoint navigator and virtual request table"`.

### Task 5: Simultaneous RAW inspector and health strip

**Files:**
- Create: `src/components/RawInspector.tsx`, `src/components/RawInspector.test.tsx`
- Create: `src/components/HealthStrip.tsx`, `src/components/HealthStrip.test.tsx`

**Interfaces:**
- `RawInspector({ exchange })` always renders two panes.
- `HealthStrip({ status, received, persisted, malformed, dropped, queueDepth, throughput, drift, reconnects, lastEventAge, sessionPath })` renders every dimension.

- [ ] Write failing RAW tests for simultaneous panes, exact CRLF content, absent response, reconstructed/truncated/masked labels, artifact metadata, and binary media labels.
- [ ] Implement bounded selectable monospace panes with sticky provenance headers. Never synthesize an absent response.
- [ ] Write failing health tests for all counters, degraded loss state, session path title, and text/icon state independent of color.
- [ ] Implement the compact health strip and deterministic state derivation.
- [ ] Run both component test files and expect all tests to pass.
- [ ] Commit with `git commit -m "feat: inspect raw exchanges and capture health"`.

### Task 6: Integrated Proxyman-style workspace

**Files:**
- Create: `src/components/Toolbar.tsx`, `src/components/Toolbar.test.tsx`
- Replace: `src/App.tsx`
- Create: `src/App.test.tsx`, `src/styles.css`
- Modify: `src/main.tsx`

**Interfaces:**
- `App({ client = api })` permits an injected command client in tests.
- State is bounded to current preflight, session, endpoint summaries, one exchange page, selected request ID, text/endpoint filters, offset, busy/error state, and health summary.

- [ ] Write failing toolbar and application tests for iPhone preflight, verified capture, endpoint loading, first-row selection, endpoint filtering, query refresh, paging, warning dismissal, persistent RAW panes, and stable selection when the ID remains.
- [ ] Implement compact toolbar semantics: device, profile, capture actions, filter, health, time, and size.
- [ ] Implement one reducer plus stale-request guards and debounced text queries. Retain selection by request ID and select the first row only when the previous identity is absent.
- [ ] Implement the complete CSS Grid visual system: toolbar; 232px device/endpoint sidebar; request table; bottom split RAW panes; 30px health strip; compact macOS typography; 28–32px rows; accessible focus; label-plus-color evidence; persisted split sizes; minimum 1080x680.
- [ ] Run `bun test && bun run check && bun run build`; expect all tests, type checks, and production build to pass.
- [ ] Commit with `git commit -m "feat: deliver proxbot observability workspace"`.

### Task 7: Documentation, desktop build, and visual verification

**Files:**
- Modify: `README.md`, `docs/testing/foundation-verification.md`, `.gitignore`
- Create: `docs/testing/react-observability-verification.md`
- Generate: `artifacts/verification/` screenshots (kept locally if `artifacts` remains ignored)

**Interfaces:** Produces a reproducible Bun setup/test/build guide and a verified macOS app bundle.

- [ ] Replace stale pnpm/Svelte instructions with Bun/React/Vite commands. Document the device/domain/IP/request/raw layout, bounded query boundary, raw provenance, and health counters without overstating unfinished capture providers.
- [ ] Run `bun install --frozen-lockfile`, `bun test`, `bun run check`, `bun run build`, frozen `uv sync`, full pytest, provider build, Rust fmt/test/clippy, and `bun run tauri:build -- --debug --bundles app`.
- [ ] Launch the deterministic UI and visually inspect 1440x900 and 1080x680: clipping, split panes, selection, keyboard focus, domain/IP filtering, raw scrolling, and health counters. Save screenshots and correct every observed defect.
- [ ] Verify repository hygiene: one `bun.lock`; no pnpm lock/workspace, Svelte config, or `.svelte` sources; clean `git diff --check`.
- [ ] Commit documentation with `git commit -m "docs: verify React observability workspace"`.
- [ ] Re-read the approved spec and confirm Bun-only workflow, React/Vite, device/domain/IP navigator, bounded request table, simultaneous RAW panes, provenance labels, and loss counters. Record broader capture-engine milestones truthfully as future scope.

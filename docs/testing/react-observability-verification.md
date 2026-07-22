# proxbot React observability workspace verification

**Verification time (UTC):** 2026-07-22T19:42:13Z

**Source branch:** `feature/react-observability` (fast-forwarded to `main` for publication)

**Implementation commit under test:** `f916ec725925b1cb902d0d85d66a3283b5f1dbc8`

**Release:** [`v0.1.0-alpha.2`](https://github.com/auersperg/proxbot/releases/tag/v0.1.0-alpha.2)

**Host:** macOS 26.5.2 (25F84), Apple Silicon (`arm64`)

This record verifies the Bun/React/Vite observability workspace, its bounded Rust/SQLite command boundary, durable JSONL/SQLite repair behavior, deterministic provider path, ad-hoc-signed debug macOS bundle, release archive, and supported window sizes. It does not claim that the later live HTTP(S) proxy, TLS-pinning instrumentation, or synchronized live-device plaintext milestones are implemented.

## Toolchain

| Tool | Verified version |
|---|---|
| Bun | 1.3.14 |
| React / React DOM | 19.2.8 / 19.2.8 |
| TypeScript | 7.0.2 |
| Vite / Vitest | 8.1.5 / 4.1.10 |
| Tauri CLI / runtime crate | 2.11.4 / 2.11.5 |
| Rust / Cargo | 1.97.1 / 1.97.1 |
| Python | 3.14.5 |
| uv | 0.11.8 |

## Automated verification

All commands were run against the implementation commit in the isolated implementation worktree.

| Command | Observed result |
|---|---|
| `bun install --frozen-lockfile` | passed; 125 installs across 185 packages checked, no changes |
| `bun run test` | passed; **11 files, 42 tests** |
| `bun run check` | passed; TypeScript emitted no errors |
| `bun run build` | passed; 31 modules transformed and production output written to `dist/` |
| `uv sync --project sidecars/ios-provider --extra test --frozen` | passed; 99 packages checked |
| `uv run --project sidecars/ios-provider --extra test pytest -q` | passed; **13 tests** |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | passed |
| `cargo test --manifest-path src-tauri/Cargo.toml --all-targets` | passed; **49 integration tests** |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` | passed |
| `bun run tauri:build -- --debug --bundles app` | passed; provider rebuilt and one `.app` produced |
| `codesign --verify --deep --strict --verbose=2 proxbot.app` | passed |
| launch signed `Contents/MacOS/proxbot`, wait six seconds, test process liveness | passed; process and application name remained active, log was empty |
| bundled `proxbot-ios-provider fake --help` | passed; packaged CLI displayed the expected socket/session/count contract |
| `unzip -t proxbot-0.1.0-alpha.2-macos-arm64.zip` | passed; no compressed-data errors |
| extract ZIP and run strict deep `codesign` verification again | passed |
| `git diff --check` | passed |

Rust integration-test distribution:

- command contracts: **4**;
- domain/session contracts: **4**;
- event/index integrity and live repair: **7**;
- exchange materialization/query/backfill: **19**;
- deterministic capture: **3**;
- provider framing: **2**;
- provider runtime discovery: **2**;
- session storage/durability: **8**;
- total: **49**.

The regression matrix covers metadata-only pages, one selected raw detail, tri-state transformation metadata, side-specific evidence, invalid HTTP status handling, checked numeric conversions, combined endpoint caps, query consistency, deterministic paging, transactional rollback, stale React page/detail suppression, overlapping-operation busy accounting, independent error lanes, persisted splitters with compact-window clamping, virtualized 2,000-endpoint navigation, live cached-index repair, same-cardinality event/exchange corruption, redundant event-column reconstruction, deleted-index recovery, owner-only storage, atomic ready publication, and final-component/ancestor symlink refusal.

## Bounded query and evidence contract

The verified path is:

```text
provider event
  -> owner-only append-only JSONL.partial + flush/fsync
  -> transactional SQLite events/exchanges
  -> atomically finalized JSONL + checksum
  -> ready manifest published last
  -> metadata-only page_exchanges
  -> one selected get_exchange raw detail
```

Hard limits enforced by Rust are:

| Boundary | Limit |
|---|---:|
| free-text query | 1,024 UTF-8 bytes |
| endpoint value | 512 UTF-8 bytes |
| request ID | 512 UTF-8 bytes |
| endpoint summaries | 2,000 |
| exchange page | 500 rows |
| React-requested page | 200 rows |
| raw detail held by the UI | one selected exchange |

`page_exchanges` neither selects nor serializes request/response raw content. The former full-event `page_events` command was removed from the public Tauri/frontend surface. Selected-detail loading is debounced by 75 ms; text queries are debounced by 180 ms. One active-session `EventIndex` is cached, and blocking SQLite work runs in `spawn_blocking`.

Missing raw evidence remains `null`; a known response without raw content is distinguished from a missing response. Unknown reconstruction, truncation, and masking state remains unknown rather than becoming `false`. Invalid evidence classes or artifact metadata are repaired from authoritative events when possible and otherwise fail explicitly.

## Durable storage and recovery

Session directories are created exclusively with mode `0700`. Evidence, SQLite, manifest, and checksum files are mode `0600`; sensitive opens use `O_NOFOLLOW`/`O_CLOEXEC`, and SQLite session/database/event ancestors are checked before use.

Finalization publishes artifacts in this order:

1. flush and `fsync` the provider JSONL before updating derived SQLite rows;
2. rename `provider-events.jsonl.partial` atomically;
3. write and `fsync` `checksums.sha256.partial`, then rename it;
4. write and `fsync` `manifest.json.partial`, then publish `manifest.json` last;
5. synchronize containing directories after renames.

`manifest.status == "ready"` is the commit marker. The checksum file currently covers the authoritative JSONL. SQLite remains a rebuildable event/exchange query index.

On open, the index checks authoritative JSONL SHA-256, count, content-state markers, materializer revision, and derived counts. Deleted/stale/corrupt SQLite data is transactionally reconstructed from JSONL. SQLite-only legacy indexes are rebuilt from embedded `events.event_json`. Live cached reads repair dirty state before returning data. Source validation, event/exchange reconstruction, metadata refresh, and the clean-state commit occur in one `TransactionBehavior::Immediate` transaction, preventing an external SQLite writer from interleaving a stale repair. Malformed legacy input rolls the repair back.

## Visual verification

The deterministic browser client exercised the same React components and typed client interface used by Tauri. It created 80 metadata rows, selected one immutable request, loaded only that request's raw detail, applied the exact `auth.privy.io` domain filter, and kept two RAW panes visible.

| Viewport | Measured result |
|---|---|
| 1440×900 | body/shell/workspace matched viewport; no page overflow; table at `x=237`, width `1203`, height `518`; RAW inspector height `300`; 28 virtual request rows mounted; one selected row; two RAW panes |
| 1080×680 | body/shell/workspace matched viewport; no page overflow; table at `x=237`, width `843`, height `298`; RAW inspector height `300`; 10 exact-domain rows; one selected row; two RAW panes; all health fields retained |

The sidebar uses a constrained internal virtual scroller while device and evidence-source areas remain fixed. Unit and browser probes keep fewer than 100 endpoint rows mounted for a 2,000-entry inventory and verify keyboard reachability. Persisted inspector values are dynamically clamped to available viewport height, including the error-banner case.

The checked-in 1440×900 screenshot is [`screenshots/proxbot-react-observability.png`](screenshots/proxbot-react-observability.png):

```text
SHA-256 a91d3976f907fc92c1b8705ef0d8021fdff9ba0fb011af1451ce8741e9270c50
```

The local compact screenshot and geometry report were also regenerated after the final source change. The RAW panes show media type, side-specific evidence, origin, completeness, masking, and inline/artifact provenance. Unreported health measurements display `—`, not fabricated zeroes.

## Packaged application and release artifact

The exact README build command rebuilt the standalone provider, frontend, Rust core, and bundle. The build output was:

```text
src-tauri/target/debug/bundle/macos/proxbot.app
```

The bundle is an arm64 macOS application with identifier `com.auersperg.proxbot` and minimum system version 14.0. After explicit deep ad-hoc signing, strict verification reported a valid on-disk bundle and validated the nested provider. The signed application launched and remained healthy through the smoke interval.

Signed executable hashes:

```text
13f8b82cf729cef0c925f565254afece48a599fc6b2bd237f7677b29927dd0b5  proxbot
9280c46823a7fb2ddb1f0361c4fc01b3693fbd32c2f741f45a2a27bb8371fb2a  proxbot-ios-provider
```

Verified distributable archive (**72,411,125 bytes**):

```text
/Users/adam/Files/Work/Research/projects/proxbot/artifacts/proxbot-0.1.0-alpha.2-macos-arm64.zip
SHA-256 01cd46c9129062e1bbb63335e466cf921caa1a55ca379f69e604e9bd09d758a8
```

`artifacts/` is intentionally Git-ignored. The same archive is attached to the GitHub prerelease. Extraction followed by a second strict deep-signature verification passed.

## Repository and security hygiene

- exactly one JavaScript lockfile exists: `bun.lock`;
- no alternative package-manager lockfile, legacy frontend configuration/source, or unused retired frontend remains;
- tracked and pending release files contain no detected JWT, refresh/access token, seed/private-key, or private-key PEM pattern;
- browser/provider fixtures use synthetic device metadata and RFC 5737 documentation IP addresses;
- session directories are owner-only, durable files are owner-only, and exclusive creation plus final-component/ancestor symlink checks prevent redirection into pre-existing targets;
- checksum publication precedes the ready manifest;
- the production WebView uses a self/IPC CSP rather than a null policy;
- no broadcast implementation or Solana signer is present in this milestone; transaction method names occur only in deterministic fixture evidence.

## Honest implementation boundary

This release completes the React/Bun/Vite observability and bounded exchange-query milestone. It includes Frida USB device preflight, deterministic provider capture, durable JSONL/SQLite recovery, virtualized request/endpoint navigation, simultaneous RAW panes, and a signed distributable debug bundle.

The following broader product milestones remain outside this artifact:

- routing an iPhone application through a real HTTP(S) MITM proxy;
- extracting plaintext from a pinned production TLS connection;
- a synchronized live-device PCAP/syslog/process/instrumentation session started from this UI;
- Solana decoding/correlation and signing-versus-broadcast conclusions;
- protected/sanitized exports;
- crash/fault-injection qualification beyond the verified JSONL-to-SQLite rebuild, live same-cardinality repair, and atomic-ready finalization;
- ten-million-event performance qualification and streaming/range retrieval for large bodies.

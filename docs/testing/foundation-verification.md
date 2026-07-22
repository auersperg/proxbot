# Historical snapshot — TraceLab Foundation Verification

> **Historical record, not current-branch verification.** This file records the foundation verification performed on **2026-07-22** for the former TraceLab foundation branch and commit shown below. Its Node/pnpm/Svelte toolchain, bundle path, application identifier, test totals, screenshot, and hardware observations do **not** describe the current `feature/react-observability` React/Bun/Vite workspace. For current-branch commands and results, read [`react-observability-verification.md`](react-observability-verification.md).

**Verification time (UTC):** 2026-07-22T16:42:13Z  
**Branch:** `feature/tracelab-foundation`  
**Implementation commit under test:** `d1dca18`  
**Host:** macOS 26.5.2, Apple Silicon (`arm64`)

## Toolchain at the time

| Tool | Verified version |
|---|---|
| Node.js | v22.22.3 |
| pnpm | 11.5.2 |
| Rust | rustc 1.97.1 (8bab26f4f 2026-07-14) |
| Cargo | 1.97.1 (c980f4866 2026-06-30) |
| Python | 3.14.5 |
| uv | 0.11.8 |
| Tauri CLI | 2.11.4 |
| Tauri runtime crate | 2.11.5 |
| Frida Python package | 17.16.4 |

## Automated verification at the time

All commands were executed from the then-isolated implementation worktree.

| Command | Recorded result |
|---|---|
| `pnpm install --frozen-lockfile` | passed |
| `uv sync --project sidecars/ios-provider --extra test --frozen` | passed |
| `pnpm test` | 3 files, 5 tests passed |
| `pnpm check` | 0 errors, 0 warnings |
| `pnpm build` | passed; static Svelte output written to `build/` |
| `uv run --project sidecars/ios-provider --extra test pytest -q` | 4 tests passed |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | passed |
| `cargo test --manifest-path src-tauri/Cargo.toml --all-targets` | 14 integration tests passed |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | passed |
| `git diff --check` | passed |

Rust test distribution in that snapshot:

- command contract: 3;
- domain/event/state contract: 4;
- end-to-end fake capture: 2;
- cross-language provider protocol: 2;
- session store and SQLite index: 3.

## Bundle and signature at the time

Build command:

```bash
pnpm tauri build --debug --bundles app
```

Application:

```text
/Users/adam/Files/Work/Research/trace-lab/.worktrees/tracelab-foundation/src-tauri/target/debug/bundle/macos/TraceLab.app
```

The linker-generated development signature was replaced with an explicit app-bundle ad-hoc signature:

```bash
xattr -cr TraceLab.app
codesign --force --deep --sign - --timestamp=none TraceLab.app
codesign --verify --deep --strict --verbose=2 TraceLab.app
```

Recorded verification output:

```text
TraceLab.app: valid on disk
TraceLab.app: satisfies its Designated Requirement
Identifier=io.tracelab.desktop
Format=app bundle with Mach-O thin (arm64)
Signature=adhoc
Sealed Resources version=2 rules=13 files=1
```

Signed executable SHA-256:

```text
ebc37d8b3a26649b431cc22083395b500b7908b90aa5901186c678fa8b0d4a79
```

Verified distributable archive (8,126,610 bytes):

```text
/Users/adam/Files/Work/Research/trace-lab/.worktrees/tracelab-foundation/artifacts/TraceLab-0.1.0-macos-arm64-debug.zip
SHA-256 b975810d3443c132ac1ca2fb054bbdaf53db170a2633b07381ddb21bb13d3d70
```

`unzip -t` reported no errors. The `artifacts/` directory was intentionally ignored by Git so the build remained a returned artifact rather than repository source.

## Hardware and packaged-application smoke test at the time

The ad-hoc signed `.app` was launched from the generated bundle. The packaged UI opened successfully and the Frida preflight returned one connected USB device:

```json
{"available":true,"id":"0000…801E","name":"iPhone","type":"usb"}
```

The complete device identifier was intentionally omitted from that record and redacted in the UI.

The packaged application then created a deterministic provider capture through this boundary:

```text
Svelte command client
-> Tauri command
-> Rust single-capture guard/coordinator
-> supervised Python process
-> private Unix socket
-> big-endian length-prefixed MessagePack frames
-> append-only JSONL
-> SQLite index
-> paged timeline and raw inspector
```

Recorded session:

| Field | Recorded result |
|---|---|
| Session UUID | `6b33d6ae-007a-4ca9-8e4a-31dd89fcd65b` |
| Manifest status | `ready` |
| Manifest event count | 30 |
| JSONL line count | 30 |
| SQLite event count | 30 |
| Dropped count shown by UI | 0 |
| Checksum verification | `events/provider-events.jsonl: OK` |

Session path:

```text
/Users/adam/Library/Application Support/io.tracelab.desktop/sessions/6b33d6ae-007a-4ca9-8e4a-31dd89fcd65b
```

The historical screenshot is stored at [`screenshots/tracelab-bundle-verified.png`](screenshots/tracelab-bundle-verified.png).

## Evidence semantics in that snapshot

- Device presence was `OBSERVED` through the explicit local Frida preflight.
- The 30 timeline records were `OBSERVED` from the deterministic fake provider and visibly identified as provider `fake` version `0.1.0`.
- No fake-provider endpoint was presented as traffic produced by the connected iPhone.
- No `ENRICHED` chain/RPC lookup was performed.
- No transaction broadcast, chain state, or confirmation was claimed by that milestone.

## Foundation boundary at the time

The verified bundle was the design's first independently usable foundation, not the complete traffic product. Its production IPC, storage, state, command, and UI seams were present and tested; later milestones were intended to attach USB PCAP/syslog/process capture, proxy and laboratory-build instrumentation, Solana analysis, export/sanitization/recovery, and performance qualification without replacing those seams.

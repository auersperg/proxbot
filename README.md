# proxbot

`proxbot` is a local macOS observability application for capturing and inspecting evidence from a paired USB iPhone. The production path is a Tauri 2/Rust runtime, a React 19 interface, a bundled iOS provider, an independently operated optional proxy provider, and a local MCP server that lets an agent operate the same capture coordinator as the UI.

```text
iPhone
  ├─ USB pcapd → encrypted packet evidence (PCAPNG)
  ├─ USB syslog relay → structured device logs (JSONL)
  └─ Wi-Fi proxy (`deep`, explicit setup) → HTTP(S)/WebSocket evidence
                         │
                         ▼
Tauri 2 / Rust LiveCaptureService
  ├─ authoritative JSONL + derived SQLite index
  ├─ owner-only session artifacts + SHA-256 manifest
  ├─ reactive capture://status snapshots
  ├─ React/Vite desktop UI
  └─ owner-only Unix control socket
                         │
                         ▼
Official MCP stdio server → Codex or another MCP client
```

The repository is a **single Bun workspace**. Bun 1.3.14 is the only JavaScript installer, lockfile owner, and script/build orchestrator; Vitest is the frontend test engine invoked through Bun.

## Production interface

The desktop interface is deliberately compact and follows the proven traffic-inspector layout:

- connected device and trust state;
- real `Start capture`, `Stop`, `Refresh`, and timestamped marker controls;
- `HTTPS + USB` (`deep`) and `USB packets only` (`passive`) profiles;
- device → domain/IP endpoint navigator;
- virtualized, bounded packet/request table with newest evidence first;
- realtime USB packet rows with direction, L2/L3/L4 protocol, IP/ports,
  byte count, interface, and process attribution when pcapd supplies it;
- stable request selection;
- simultaneous **RAW Request** and **RAW Response** panes;
- response-missing, truncation, reconstruction, masking, and provenance indicators;
- persistent received/persisted/malformed/dropped/queue/throughput/drift/reconnect/age health strip;
- reactive status events with a one-second polling compatibility path;
- no production demo button and no synthetic client selected by the application.

Metadata pages are capped at 500 rows, endpoint inventory at 2,000 entries, and only the selected request loads raw detail. Text queries and identifiers are byte bounded in both TypeScript and Rust.

## Capture profiles and evidence boundary

| Profile | USB packet capture | Device syslog | HTTP(S) proxy | Claim |
|---|---:|---:|---:|---|
| `passive` | yes | no | no | encrypted packet evidence; observed DNS/TLS metadata may enrich endpoints |
| `deep` | yes | yes | listening | synchronized USB evidence plus proxy HTTP(S) only for explicitly routed traffic that accepts the CA |

A finalized live session contains:

```text
SESSION_UUID/
├── capture/device.pcapng
├── logs/device.jsonl                 # deep profile
├── proxy/request-bodies.bin          # deep profile, bounded; may be empty
├── proxy/response-bodies.bin         # deep profile, bounded; may be empty
├── proxy/websocket-messages.bin      # deep profile, bounded; may be empty
├── events/provider-events.jsonl      # authoritative lifecycle timeline
├── database/session.sqlite           # derived, rebuildable query index
├── checksums.sha256
└── manifest.json                     # written last; status=ready
```

Session directories are `0700`; evidence files, manifest, checksums, exports, SQLite/WAL files, and control sockets are owner-only. Finalization flushes the provider, normalizes PCAPNG for macOS libpcap compatibility, promotes authoritative JSONL, hashes observed evidence, and writes the ready manifest last.

### TLS and plaintext semantics

The built-in USB capture does **not** label encrypted packets as HTTP plaintext and does not claim TLS decryption. The `deep` profile starts the bundled [`sidecars/proxy-provider`](sidecars/proxy-provider/README.md), powered by mitmproxy, alongside USB PCAP and device logs. It covers CONNECT, HTTP/1.1, HTTP/2, WebSocket, bounded bodies, and TLS metadata, but only for traffic that the iPhone explicitly routes through it and whose trust policy accepts the local CA. It does not install or trust a CA on the iPhone and reports `certificate_pinning_bypass: false`.

USB-only capture therefore populates packet/IP rows immediately, while a domain,
HTTP path, headers, body, or RAW Response appears only when that fact is present in
proxy or instrumentation evidence. Packet rows are explicitly marked
`packet_metadata`: the table keeps a compact reconstructed summary, while selecting
the row lazily verifies its SHA-256 range in PCAPNG and shows the original captured
octets as canonical hex + ASCII.

### Deep HTTPS capture setup

1. Select **HTTPS + USB** and start capture. The HTTP(S) proxy source in the
   sidebar shows the Mac LAN endpoint chosen by the runtime.
2. On the iPhone's active Wi-Fi network, set **Configure Proxy → Manual** to that
   host and port. A different proxy process cannot occupy the same port.
3. While the iPhone is routed through proxbot, open `http://mitm.it` on the iPhone,
   install the generated profile, then explicitly enable full trust for that CA in
   iOS certificate trust settings.
4. Reproduce the request. Domains and full RAW Request/Response appear after the
   proxy actually observes an accepted request; the listener's `active` status by
   itself is not proof that the CA is installed or trusted.

Certificate-pinned applications can reject interception and remain visible only as
encrypted USB packet and bounded DNS/TLS metadata evidence. proxbot does not claim
or perform certificate-pinning bypass. Remove the manual proxy and test CA after the
research session if they are no longer needed.

## Agent automation through MCP

The local [`@proxbot/mcp-server`](apps/mcp-server/README.md) uses the stable official MCP TypeScript SDK and JSON-RPC over stdio. It opens no MCP TCP listener. Mutations go through the running app's `0600` Unix control socket; finalized-session reads use read-only SQLite with `query_only=ON` and `trusted_schema=OFF`.

The 13 tools are:

```text
proxbot_health
proxbot_device_preflight
proxbot_start_capture
proxbot_capture_status
proxbot_add_marker
proxbot_stop_capture
proxbot_list_sessions
proxbot_session_status
proxbot_list_endpoints
proxbot_query_exchanges
proxbot_get_exchange
proxbot_analyze_session
proxbot_export_exchanges
```

Recommended agent sequence:

1. `proxbot_health` and `proxbot_device_preflight`;
2. `proxbot_start_capture` and retain the session ID;
3. reproduce the action and insert `proxbot_add_marker` at important boundaries;
4. inspect `proxbot_capture_status`;
5. always call `proxbot_stop_capture` to flush and finalize;
6. page metadata before requesting one selected raw exchange;
7. run bounded aggregate analysis or create a metadata-only export.

MCP raw output redacts authentication headers, cookies, token/key/secret fields, JWT-shaped values, and sensitive query values, then applies independent UTF-8 byte caps. proxbot never requests seed phrases or private keys as credential inputs. Raw PCAP, syslog, and opt-in proxy artifacts are sensitive evidence and may contain arbitrary application data; store and delete them accordingly.

Workspace Codex configuration is checked in at [`.codex/config.toml`](.codex/config.toml). To register the source checkout globally:

```bash
codex mcp add proxbot -- \
  /absolute/path/to/proxbot/scripts/proxbot-mcp
codex mcp list
```

The desktop app must be running for capture mutations. Read tools continue to work for finalized sessions when the app is closed.

## Requirements

- Apple Silicon Mac running macOS 14 or newer;
- paired and trusted USB iPhone for live capture;
- [Bun](https://bun.sh/) 1.3.14;
- stable Rust with `rustfmt` and `clippy`;
- Python 3.12+ and `uv` to rebuild or test Python providers.

## Install and run

```bash
bun install --frozen-lockfile
uv sync --project sidecars/ios-provider --extra test --frozen
uv sync --project sidecars/proxy-provider --extra test --frozen
bun run tauri dev
```

The Start button remains disabled until device preflight confirms available, paired, and trusted. The same gates are enforced in Rust and through MCP.

## Bun command surface

```bash
bun run dev                 # Vite only
bun run test                # React + MCP tests
bun run check               # TypeScript checks for both workspaces
bun run build               # production React build
bun run hygiene             # Bun-only repository boundary
bun run build:sidecars      # iOS provider + compiled MCP executable
bun run mcp:start           # MCP server over stdio
bun run mcp:hardware-smoke  # agent→MCP→UDS→Tauri→USB→finalized session
bun run tauri:build -- --debug --bundles app
```

There is exactly one JavaScript lockfile: [`bun.lock`](bun.lock). Nested JavaScript lockfiles and alternate package-manager artifacts are rejected by `bun run hygiene` and CI.

## Complete verification gate

```bash
bun install --frozen-lockfile
bun run hygiene
bun run test
bun run check
bun run build

uv sync --project sidecars/ios-provider --extra test --frozen
uv run --project sidecars/ios-provider --extra test \
  pytest -q sidecars/ios-provider/tests
uv run --project sidecars/ios-provider \
  python -m compileall -q sidecars/ios-provider/src sidecars/ios-provider/tests

uv sync --project sidecars/proxy-provider --extra test --frozen
uv run --project sidecars/proxy-provider --extra test \
  pytest -q sidecars/proxy-provider/tests
uv run --project sidecars/proxy-provider \
  python -m compileall -q sidecars/proxy-provider/src sidecars/proxy-provider/tests

cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets
cargo clippy --locked --manifest-path src-tauri/Cargo.toml \
  --all-targets --all-features -- -D warnings
```

The hardware smoke requires a running Tauri app and connected iPhone. It uses the official MCP client/server pair to run preflight → deep capture → verify a realtime indexed packet → marker → status → stop, then fails if the final state is not ready or either finalized capture artifact is empty.

## Build and release

```bash
bun run build:sidecars
bun run tauri:build -- --debug --bundles app
```

The debug bundle is produced at:

```text
src-tauri/target/debug/bundle/macos/proxbot.app
```

The tag-driven release workflow repeats all gates, enforces version parity, requires Apple Developer ID credentials, signs and notarizes the macOS app, validates it with `codesign`, Gatekeeper, and `stapler`, verifies ZIP integrity, emits SHA-256, and publishes the exact verified artifact. A local ad-hoc debug build is useful for development but is not represented as a notarized public release.

## Bundled proxy provider

The `deep` coordinator runs this provider alongside the USB provider. It remains
independently testable without changing the `passive` USB evidence semantics:

```bash
uv run --project sidecars/proxy-provider proxbot-proxy-provider probe
uv run --project sidecars/proxy-provider proxbot-proxy-provider start \
  --socket CONTROLLED_PROVIDER_SOCKET \
  --session-id SESSION_UUID \
  --artifact-root SESSION_DIR/proxy \
  --confdir SESSION_DIR/ca \
  --listen-host 127.0.0.1 \
  --listen-port 9090
```

It binds loopback by default; non-loopback listeners require explicit `--allow-remote`. Public CA fingerprint reporting never exposes the CA private key.

## Security and data handling

- no application telemetry;
- no production mock/demo path;
- owner-only local IPC and evidence;
- symlink refusal and `O_NOFOLLOW` for sensitive files;
- bounded MessagePack/JSON frames, queues, identifiers, rows, raw bytes, and exports;
- authoritative JSONL before derived SQLite updates;
- credential redaction before model-visible raw output;
- no dedicated seed/private-key collection feature; raw evidence is treated as potentially credential-bearing;
- no automatic CA installation;
- no certificate-pinning-bypass claim;
- no fabricated plaintext, transaction, or protocol-correlation claim.

The access, refresh, and identity tokens pasted during earlier traffic investigation should be revoked/rotated; proxbot's MCP redaction prevents those credential classes from being returned to an agent.

## Engineering records

- [Product design](docs/superpowers/specs/2026-07-22-proxbot-design.md)
- [Production readiness and verified boundary](docs/engineering/production-readiness.md)
- [MCP implementation](apps/mcp-server/README.md)
- [Verified Kamino withdrawal signing and broadcast flow](docs/research/2026-07-23-kamino-withdraw-signing-flow.md)
- [Verified live two-signer Kamino SOL deposit](docs/research/2026-07-23-live-two-signer-kamino-deposit.md)
- [Verified live CH single-signer self-transfer](docs/research/2026-07-23-live-ch-self-signed-self-transfer.md)
- [CHvpg deep on-chain funds, instruction, and authority map](docs/research/2026-07-23-ch-account-interaction-map.md)
- [CHvpg CPI/helper capability map (JSON)](artifacts/solana/ch-cpi-capability-map.json)
- [CHvpg complete XPlace method matrix (CSV)](artifacts/solana/ch-method-capabilities.csv)
- [CHvpg atomic-flow correlations (CSV)](artifacts/solana/ch-atomic-flow-correlations.csv)
- [CHvpg consolidated fund ledger (CSV)](artifacts/solana/ch-account-funds.csv)
- [0.2.0-rc.1 end-to-end verification](docs/testing/0.2.0-rc.1-verification.md)
- [Previous React observability verification](docs/testing/react-observability-verification.md)

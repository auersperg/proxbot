# proxbot agent contract

## Runtime ownership

- The Rust/Tauri core is the source of truth for device readiness, live capture
  state, health, session finalization, and the owner-only control socket.
- The React client is presentation only. Keep lists and raw-detail reads bounded.
- The local stdio MCP server is the supported automation surface for agents.
  It may read finalized session indexes directly and sends mutations through the
  running app's owner-only control socket.

## Agent workflow

1. Call `proxbot_health` and `proxbot_device_preflight` before a live session.
2. Start with `proxbot_start_capture`; retain the returned session ID.
3. Use `proxbot_capture_status` for health and `proxbot_add_marker` around the
   reproduced action.
4. Always call `proxbot_stop_capture` to flush and finalize evidence.
5. Inspect bounded metadata with `proxbot_list_endpoints` and
   `proxbot_query_exchanges`; request raw detail only for one selected request ID.
6. Use `proxbot_analyze_session` or metadata-only export for repeatable analysis.

## Evidence and secrets

- Preserve observed, enriched, and inferred evidence labels.
- Never describe encrypted packets as plaintext or application-correlated
  plaintext as packet decryption.
- MCP raw detail is deliberately credential-redacted and byte-capped. Do not
  copy credentials, signing secrets, seed material, or private keys into source,
  reports, prompts, logs, fixtures, or command history.
- Keep test fixtures under test directories. Production code must not select a
  fixture provider or synthetic browser client.

## Repository commands

Use Bun 1.3.14 from the repository root and the single root lockfile:

```bash
bun install --frozen-lockfile
bun run hygiene
bun run test
bun run check
bun run build
bun run build:sidecars
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
uv run --project sidecars/ios-provider --extra test pytest -q sidecars/ios-provider/tests
uv run --project sidecars/proxy-provider --extra test pytest -q sidecars/proxy-provider/tests
```

With a running Tauri app and paired iPhone, the release-candidate hardware gate
is `bun run mcp:hardware-smoke`. It must finish the active session even when an
intermediate assertion fails.

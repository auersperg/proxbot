# proxbot MCP server

Production local MCP surface for automating proxbot with an agent. It uses the
stable official `@modelcontextprotocol/sdk` and MCP stdio transport. The MCP
process does not open a TCP listener.

## Runtime architecture

```text
MCP client
  ↕ MCP JSON-RPC over stdio
@proxbot/mcp-server (compiled Bun executable or Bun workspace process)
  ├─ owner-only proxbot control.sock → running Tauri app → live capture coordinator
  ├─ owner-only iOS provider executable → USB device preflight fallback
  └─ read-only SQLite indexes + owner-only session exports
```

The app control bridge uses one bounded request/response per owner-only Unix
socket connection. Requests and responses use a versioned envelope, random UUID
correlation ID, strict method allowlist, 64 KiB framing limit, and timeout. The
MCP transport itself remains the official SDK stdio implementation.

## Bun workspace

The repository root owns the one `bun.lock`. Install and verify from the root:

```bash
bun install --frozen-lockfile
bun run mcp:check
bun run mcp:test
bun run mcp:start
```

The repository uses Bun exclusively, with exactly one lockfile at the root and
no nested package-manager workspace.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PROXBOT_SESSIONS_ROOT` | `~/Library/Application Support/com.auersperg.proxbot/sessions` | Authoritative session root |
| `PROXBOT_CONTROL_SOCKET` | `~/Library/Application Support/com.auersperg.proxbot/control.sock` | Running app control bridge |
| `PROXBOT_PROVIDER_BIN` | unset | Signed provider fallback for device preflight |
| `PROXBOT_CONTROL_BIN` | unset | Optional local control CLI fallback |
| `PROXBOT_COMMAND_TIMEOUT_MS` | `120000` | Subprocess/socket timeout, bounded to 1–120 seconds |
| `PROXBOT_MAX_RAW_BYTES` | `65536` | Hard maximum raw bytes per side, bounded to 1–256 KiB |

The control socket must be a real Unix socket, owned by the current user, with no
group/world permissions. Symlink sockets and symlink session artifacts are
rejected.

## Tools

| Tool | Effect |
|---|---|
| `proxbot_health` | Read MCP, control bridge, provider, and latest-session readiness |
| `proxbot_device_preflight` | Read USB device, pairing, trust, and developer-mode readiness |
| `proxbot_start_capture` | Start a `passive` or `deep` production capture |
| `proxbot_capture_status` | Read the current real-time capture snapshot |
| `proxbot_add_marker` | Append an analyst marker to the active session |
| `proxbot_stop_capture` | Stop, flush, and finalize active capture |
| `proxbot_list_sessions` | List up to 200 durable sessions |
| `proxbot_session_status` | Read durable status/counts for one session |
| `proxbot_list_endpoints` | Read up to 2,000 domains/IPs |
| `proxbot_query_exchanges` | Page up to 500 metadata-only exchanges |
| `proxbot_get_exchange` | Read one selected capped request/response raw detail |
| `proxbot_analyze_session` | Aggregate hosts, methods, statuses, protocols, latency, warnings |
| `proxbot_export_exchanges` | Atomically write up to 10,000 metadata rows as JSONL |

All tools publish Zod input/output schemas, structured MCP output, and MCP tool
annotations. Read tools are explicitly read-only. Mutating tools are marked as
local, non-open-world operations.

## Evidence and secret handling

- Session IDs must be UUIDs and resolve directly below the configured root.
- SQLite opens read-only with `query_only=ON` and `trusted_schema=OFF`.
- Dirty indexes are not read; proxbot repairs them from authoritative JSONL.
- Metadata queries are paged and bounded. Raw bodies are fetched only for one
  selected request ID.
- MCP raw output always redacts credential headers, credential query values,
  credential-shaped JSON properties, and JWT-shaped values.
- Raw output is capped by UTF-8 byte length independently for request and response.
- Exports contain metadata only, use exclusive `0600` partial files, `fsync`,
  atomic rename, and containing-directory `fsync`. Existing exports are preserved.
- Runtime diagnostics go to stderr only; stdout is reserved for MCP framing.

## Compile for the Tauri bundle

```bash
bun run --cwd apps/mcp-server compile:macos
codesign --force --sign - src-tauri/binaries/proxbot-mcp-aarch64-apple-darwin
```

The output is:

```text
src-tauri/binaries/proxbot-mcp-aarch64-apple-darwin
```

The Tauri bundle must include that external binary alongside the iOS provider.

## MCP client configuration

Development workspace:

```json
{
  "mcpServers": {
    "proxbot": {
      "command": "bun",
      "args": [
        "run",
        "/absolute/path/to/proxbot/apps/mcp-server/src/index.ts"
      ]
    }
  }
}
```

Packaged binary:

```json
{
  "mcpServers": {
    "proxbot": {
      "command": "/absolute/path/to/proxbot-mcp-aarch64-apple-darwin"
    }
  }
}
```

## Verification

```bash
bun run --cwd apps/mcp-server check
bun run --cwd apps/mcp-server test
bun run --cwd apps/mcp-server compile:macos
bun run --cwd apps/mcp-server hardware-smoke
```

The integration suite starts the real official SDK stdio server/client pair,
uses a real temporary SQLite database, exercises an actual Unix socket, verifies
structured tool discovery/calls, redaction, path confinement, dirty-index
refusal, and durable export behavior. Test-only fixtures stay under `tests/` and
are not referenced by production code.

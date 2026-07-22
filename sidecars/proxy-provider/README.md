# proxbot proxy provider

Optional production capture provider powered by mitmproxy 12.2.3. It observes traffic explicitly routed through the configured proxy and emits proxbot schema-v1 MessagePack frames over a Unix socket.

## Commands

```sh
proxbot-proxy-provider probe
proxbot-proxy-provider ca-info --confdir PATH
proxbot-proxy-provider start \
  --socket PATH --session-id UUID \
  --artifact-root SESSION/proxy --confdir SESSION/ca \
  --listen-host 127.0.0.1 --listen-port 9090
```

`start` replaces itself with `mitmdump`, so normal SIGINT/SIGTERM handling reaches mitmproxy directly and the addon flushes a final health event, `provider.stopped`, its bounded event queue, and body artifacts.

## Evidence contract

- `network.request` and `network.response` cover CONNECT, HTTP/1.1, and HTTP/2 flows seen by mitmproxy.
- `network.websocket` records direction/type/length and a bounded message artifact.
- `network.tls` records SNI, ALPN, TLS version, and cipher metadata supplied by mitmproxy.
- Request/response payloads contain explicitly marked reconstructed raw views and owner-only, append-only body artifact references.
- Per-body, total-body, metadata-frame, event-queue, identifier, and listen-port bounds are enforced.
- `provider.health` exposes received/emitted/sent/malformed/dropped/send-error/queue/active-flow/artifact counters.
- Remote listeners require the explicit `--allow-remote` switch.

## TLS scope

The provider creates and uses mitmproxy's local CA in the supplied owner-only `confdir`. HTTPS plaintext is available only when the client routes through the proxy, trusts that CA, and its trust policy accepts interception. `ca-info` returns public certificate locations and the public certificate SHA-256 fingerprint; it never returns private key material. The provider does not install the CA on devices and does not implement certificate-pinning bypass.

from __future__ import annotations

import ipaddress
import os
import threading
import time
from pathlib import Path
from typing import Any, Iterable

from .artifacts import BodyArtifactStore
from .events import EventSink

MAX_RAW_HEADERS = 256 * 1024


def _value(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        return value.decode("latin-1", "replace")
    return str(value)


def _header_lines(headers: Any) -> list[tuple[str, str]]:
    fields = getattr(headers, "fields", None)
    if fields is not None:
        return [(_value(name) or "", _value(value) or "") for name, value in fields]
    items: Iterable[tuple[Any, Any]] = headers.items(multi=True) if hasattr(headers, "items") else ()
    return [(_value(name) or "", _value(value) or "") for name, value in items]


def _body(message: Any) -> tuple[bytes, bytes, str | None]:
    """Return exact wire bytes, a decoded display body, and applied encoding.

    mitmproxy's ``raw_content`` preserves the content-encoded wire entity,
    while ``content`` applies Content-Encoding decoding. Keep the former for
    the append-only evidence artifact and use the latter only for a bounded,
    explicitly marked analyst view.
    """

    wire = getattr(message, "raw_content", None)
    if wire is None:
        wire = getattr(message, "content", None)
    wire_bytes = bytes(wire) if wire is not None else b""
    headers = getattr(message, "headers", None)
    encoding = _value(
        getattr(headers, "get", lambda *_: None)("content-encoding")
    )
    if not encoding:
        return wire_bytes, wire_bytes, None
    try:
        decoded = getattr(message, "content", None)
    except (ValueError, TypeError):
        decoded = None
    if decoded is None:
        return wire_bytes, wire_bytes, None
    decoded_bytes = bytes(decoded)
    if decoded_bytes == wire_bytes:
        return wire_bytes, wire_bytes, None
    return wire_bytes, decoded_bytes, encoding


def _endpoint(flow: Any) -> tuple[str | None, int | None]:
    address = getattr(getattr(flow, "server_conn", None), "ip_address", None)
    if isinstance(address, tuple) and address:
        return _value(address[0]), int(address[1]) if len(address) > 1 else None
    return None, None


def _is_ip_address(value: str | None) -> bool:
    if not value:
        return False
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return False
    return True


def _request_identity(flow: Any) -> tuple[str | None, str | None, list[str]]:
    """Resolve the HTTP destination without discarding transparent-proxy SNI.

    In WireGuard mode the HTTP request target is frequently represented by the
    upstream IP address even though mitmproxy observed the original hostname in
    the TLS connection. Prefer that per-flow SNI and preserve the HTTP host as a
    candidate instead of forcing the UI to display only CDN addresses.
    """

    request = getattr(flow, "request", None)
    http_host = _value(
        getattr(request, "pretty_host", None) or getattr(request, "host", None)
    )
    server_sni = _value(
        getattr(getattr(flow, "server_conn", None), "sni", None)
    )
    client_sni = _value(
        getattr(getattr(flow, "client_conn", None), "sni", None)
    )
    candidates: list[str] = []
    for candidate in (client_sni, server_sni, http_host):
        if candidate and candidate not in candidates:
            candidates.append(candidate)

    sni = client_sni or server_sni
    if sni:
        return sni, "tls.sni", candidates
    if http_host:
        return (
            http_host,
            "destination.ip" if _is_ip_address(http_host) else "http.host",
            candidates,
        )
    return None, None, candidates


def _media_type(message: Any, decoded_encoding: str | None) -> str:
    content_type = _value(
        getattr(getattr(message, "headers", None), "get", lambda *_: None)(
            "content-type"
        )
    ) or "application/octet-stream"
    if decoded_encoding:
        return f"{content_type}; content-decoded={decoded_encoding}"
    return content_type


def _raw_message(
    start_line: str,
    headers: list[tuple[str, str]],
    body: bytes,
) -> tuple[str, int, int]:
    header_block = "\r\n".join(f"{name}: {value}" for name, value in headers).encode("latin-1", "replace")
    header_bytes_dropped = max(0, len(header_block) - MAX_RAW_HEADERS)
    header_block = header_block[:MAX_RAW_HEADERS]
    raw = start_line.encode("latin-1", "replace") + b"\r\n" + header_block + b"\r\n\r\n" + body
    return raw.decode("latin-1", "replace"), header_bytes_dropped, len(raw)


class ProxyCaptureAddon:
    def __init__(
        self,
        sink: EventSink,
        artifacts: BodyArtifactStore,
        *,
        listen_host: str,
        listen_port: int,
        transport: str = "regular",
        client_config_path: str | None = None,
        advertised_host: str | None = None,
        health_interval: float = 1.0,
    ):
        if health_interval <= 0:
            raise ValueError("health interval must be positive")
        self.sink = sink
        self.artifacts = artifacts
        self.listen_host = listen_host
        self.listen_port = listen_port
        self.transport = transport
        self.client_config_path = client_config_path
        self.advertised_host = advertised_host
        self.health_interval = health_interval
        self.received = 0
        self.malformed = 0
        self.body_bytes_dropped = 0
        self._active: set[str] = set()
        self._stop = threading.Event()
        self._health: threading.Thread | None = None

    def running(self) -> None:
        self.sink.emit(
            "provider.ready",
            {
                "fixture": False,
                "provider": "proxy-mitm",
                "listen_host": self.listen_host,
                "listen_port": self.listen_port,
                "transport": self.transport,
                "advertised_host": self.advertised_host,
                "client_config_path": self.client_config_path,
                "capabilities": [
                    "http_connect",
                    "http_1_1",
                    "http_2",
                    "websocket",
                    "tls_metadata",
                    "bounded_body_artifacts",
                    *(
                        ["wireguard_server", "transparent_external_device_capture"]
                        if self.transport == "wireguard"
                        else []
                    ),
                ],
                "coverage": [
                    (
                        "wireguard_routed_traffic"
                        if self.transport == "wireguard"
                        else "configured_proxy_traffic"
                    ),
                    "http_metadata",
                    "bounded_application_plaintext",
                ],
                "tls_interception": "requires trusted proxbot CA and compatible client trust policy",
                "certificate_pinning_bypass": False,
            },
        )
        self._health = threading.Thread(target=self._health_loop, name="proxbot-proxy-health", daemon=True)
        self._health.start()

    def request(self, flow: Any) -> None:
        try:
            request = flow.request
            request_id = str(flow.id)
            wire_body, display_body, decoded_encoding = _body(request)
            artifact = self.artifacts.append("request", wire_body)
            self.body_bytes_dropped += artifact.dropped_bytes
            headers = _header_lines(request.headers)
            version = _value(getattr(request, "http_version", None)) or "HTTP/1.1"
            path = _value(getattr(request, "path", None)) or "/"
            method = _value(getattr(request, "method", None)) or "UNKNOWN"
            wire_captured = int(artifact.ref["length"]) if artifact.ref else 0
            display_captured = (
                min(len(display_body), self.artifacts.per_body_limit)
                if decoded_encoding
                else wire_captured
            )
            host, host_source, domain_candidates = _request_identity(flow)
            raw, header_bytes_dropped, captured_raw_bytes = _raw_message(
                f"{method} {path} {version}",
                headers,
                display_body[:display_captured],
            )
            ip, port = _endpoint(flow)
            self._active.add(request_id)
            self.received += 1
            self.sink.emit(
                "network.request",
                {
                    "request_id": request_id,
                    "method": method,
                    "scheme": _value(getattr(request, "scheme", None)),
                    "host": host,
                    "host_source": host_source,
                    "domain_candidates": domain_candidates,
                    "port": int(getattr(request, "port", 0)) or port,
                    "ip": ip,
                    "path": path,
                    "protocol": version,
                    "headers": headers,
                    "request_bytes": (
                        captured_raw_bytes
                        - display_captured
                        + len(wire_body)
                        + header_bytes_dropped
                    ),
                    "captured_raw_bytes": captured_raw_bytes,
                    "body_bytes": len(wire_body),
                    "body_bytes_captured": wire_captured,
                    "body_bytes_dropped": artifact.dropped_bytes,
                    "display_body_bytes": len(display_body),
                    "display_body_bytes_captured": display_captured,
                    "content_decoded": decoded_encoding is not None,
                    "content_encoding": decoded_encoding,
                    "header_bytes_dropped": header_bytes_dropped,
                    "raw": raw,
                    "media_type": _media_type(request, decoded_encoding),
                    "tls": "intercepted" if _value(getattr(request, "scheme", None)) == "https" else "cleartext",
                    "reconstructed": True,
                    "truncated": (
                        artifact.truncated
                        or display_captured < len(display_body)
                        or header_bytes_dropped > 0
                    ),
                    "masked": False,
                    "body_artifact_scope": "body",
                },
                raw_ref=artifact.ref,
            )
        except Exception as error:  # addon boundary: report malformed flow without stopping proxy
            self.malformed += 1
            self.sink.emit("provider.error", {"hook": "request", "message": str(error), "recoverable": True}, parse_status="malformed")

    def http_connect(self, flow: Any) -> None:
        """CONNECT is a proxy instruction and does not receive the normal request hook."""
        self.request(flow)

    def http_connected(self, flow: Any) -> None:
        """Pair a successful CONNECT instruction with mitmproxy's generated response."""
        self.response(flow)

    def http_connect_error(self, flow: Any) -> None:
        if getattr(flow, "response", None) is not None:
            self.response(flow)
        else:
            self.error(flow)

    def response(self, flow: Any) -> None:
        try:
            response = flow.response
            request = flow.request
            request_id = str(flow.id)
            wire_body, display_body, decoded_encoding = _body(response)
            artifact = self.artifacts.append("response", wire_body)
            self.body_bytes_dropped += artifact.dropped_bytes
            headers = _header_lines(response.headers)
            version = _value(getattr(response, "http_version", None)) or _value(getattr(request, "http_version", None)) or "HTTP/1.1"
            status = int(response.status_code)
            reason = _value(getattr(response, "reason", None)) or ""
            wire_captured = int(artifact.ref["length"]) if artifact.ref else 0
            display_captured = (
                min(len(display_body), self.artifacts.per_body_limit)
                if decoded_encoding
                else wire_captured
            )
            raw, header_bytes_dropped, captured_raw_bytes = _raw_message(
                f"{version} {status} {reason}".rstrip(),
                headers,
                display_body[:display_captured],
            )
            started = getattr(request, "timestamp_start", None)
            ended = getattr(response, "timestamp_end", None) or time.time()
            duration_ms = max(0, round((ended - started) * 1000)) if started is not None else None
            self._active.discard(request_id)
            self.received += 1
            self.sink.emit(
                "network.response",
                {
                    "request_id": request_id,
                    "status": status,
                    "protocol": version,
                    "headers": headers,
                    "duration_ms": duration_ms,
                    "response_bytes": (
                        captured_raw_bytes
                        - display_captured
                        + len(wire_body)
                        + header_bytes_dropped
                    ),
                    "captured_raw_bytes": captured_raw_bytes,
                    "body_bytes": len(wire_body),
                    "body_bytes_captured": wire_captured,
                    "body_bytes_dropped": artifact.dropped_bytes,
                    "display_body_bytes": len(display_body),
                    "display_body_bytes_captured": display_captured,
                    "content_decoded": decoded_encoding is not None,
                    "content_encoding": decoded_encoding,
                    "header_bytes_dropped": header_bytes_dropped,
                    "raw": raw,
                    "media_type": _media_type(response, decoded_encoding),
                    "reconstructed": True,
                    "truncated": (
                        artifact.truncated
                        or display_captured < len(display_body)
                        or header_bytes_dropped > 0
                    ),
                    "masked": False,
                    "body_artifact_scope": "body",
                },
                raw_ref=artifact.ref,
            )
        except Exception as error:
            self.malformed += 1
            self.sink.emit("provider.error", {"hook": "response", "message": str(error), "recoverable": True}, parse_status="malformed")

    def websocket_message(self, flow: Any) -> None:
        websocket = getattr(flow, "websocket", None)
        messages = getattr(websocket, "messages", ())
        if not messages:
            return
        message = messages[-1]
        content = bytes(message.content)
        artifact = self.artifacts.append("websocket", content)
        self.body_bytes_dropped += artifact.dropped_bytes
        self.received += 1
        self.sink.emit(
            "network.websocket",
            {
                "request_id": str(flow.id),
                "from_client": bool(message.from_client),
                "message_type": _value(getattr(message, "type", None)),
                "message_bytes": len(content),
                "truncated": artifact.truncated,
            },
            raw_ref=artifact.ref,
        )

    def tls_established_client(self, data: Any) -> None:
        self._emit_tls("client", getattr(data, "conn", None))

    def tls_established_server(self, data: Any) -> None:
        self._emit_tls("server", getattr(data, "conn", None))

    def _emit_tls(self, side: str, connection: Any) -> None:
        self.received += 1
        self.sink.emit(
            "network.tls",
            {
                "side": side,
                "sni": _value(getattr(connection, "sni", None)),
                "alpn": _value(getattr(connection, "alpn", None)),
                "tls_version": _value(getattr(connection, "tls_version", None)),
                "cipher": _value(getattr(connection, "cipher", None)),
                "certificate_pinning_bypass": False,
            },
        )

    def error(self, flow: Any) -> None:
        self._active.discard(str(flow.id))
        self.sink.emit("network.error", {"request_id": str(flow.id), "message": _value(getattr(flow.error, "msg", flow.error))})

    def _health_loop(self) -> None:
        while not self._stop.wait(self.health_interval):
            self.sink.emit("provider.health", self.health_payload())

    def health_payload(self) -> dict[str, Any]:
        return {
            "received": self.received,
            "emitted": self.sink.counters.accepted,
            "sent": self.sink.counters.sent,
            "malformed": self.malformed,
            "dropped": self.sink.counters.dropped,
            "send_errors": self.sink.counters.send_errors,
            "queue_depth": self.sink.queue_depth,
            "active_flows": len(self._active),
            "artifact_bytes": self.artifacts.written,
            "body_bytes_dropped": self.body_bytes_dropped,
            "certificate_pinning_bypass": False,
            "transport": self.transport,
        }

    def done(self) -> None:
        self._stop.set()
        if self._health is not None:
            self._health.join(timeout=max(1.0, self.health_interval * 2))
        self.sink.emit("provider.health", self.health_payload())
        self.sink.emit("provider.stopped", {"reason": "requested", "health": self.health_payload()})
        self.sink.close()
        self.artifacts.close()


def addon_from_environment() -> ProxyCaptureAddon:
    socket_path = Path(os.environ["PROXBOT_PROXY_SOCKET"])
    session_id = os.environ["PROXBOT_PROXY_SESSION_ID"]
    root = Path(os.environ["PROXBOT_PROXY_ARTIFACT_ROOT"])
    return ProxyCaptureAddon(
        EventSink(socket_path, session_id, int(os.environ.get("PROXBOT_PROXY_QUEUE_SIZE", "4096"))),
        BodyArtifactStore(
            root,
            int(os.environ.get("PROXBOT_PROXY_BODY_LIMIT", str(1024 * 1024))),
            int(os.environ.get("PROXBOT_PROXY_TOTAL_BODY_LIMIT", str(512 * 1024 * 1024))),
        ),
        listen_host=os.environ.get("PROXBOT_PROXY_LISTEN_HOST", "127.0.0.1"),
        listen_port=int(os.environ.get("PROXBOT_PROXY_LISTEN_PORT", "9090")),
        transport=os.environ.get("PROXBOT_PROXY_MODE", "regular"),
        client_config_path=(
            os.environ.get("PROXBOT_PROXY_WIREGUARD_CLIENT_CONFIG") or None
        ),
        advertised_host=os.environ.get("PROXBOT_PROXY_ADVERTISE_HOST") or None,
        health_interval=float(os.environ.get("PROXBOT_PROXY_HEALTH_INTERVAL", "1.0")),
    )

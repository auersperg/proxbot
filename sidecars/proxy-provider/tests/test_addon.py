from queue import Queue
from types import SimpleNamespace
from pathlib import Path
import gzip

from mitmproxy import http

from proxbot_proxy_provider.addon import MAX_RAW_HEADERS, ProxyCaptureAddon
from proxbot_proxy_provider.artifacts import BodyArtifactStore
from proxbot_proxy_provider.events import SinkCounters


class Headers:
    def __init__(self, *fields: tuple[bytes, bytes]):
        self.fields = fields

    def get(self, name: str):
        needle = name.lower().encode()
        for key, value in self.fields:
            if key.lower() == needle:
                return value.decode("latin-1")
        return None


class Sink:
    def __init__(self):
        self.events = []
        self.counters = SinkCounters()
        self._queue = Queue()
        self.closed = False

    def emit(self, kind, payload, *, raw_ref=None, parse_status="parsed"):
        self.counters.accepted += 1
        self.counters.sent += 1
        self.events.append({"kind": kind, "payload": payload, "raw_ref": raw_ref, "parse_status": parse_status})
        return True

    @property
    def queue_depth(self):
        return self._queue.qsize()

    def close(self):
        self.closed = True


def flow(method="POST", request_body=b"hello", response_body=b"world"):
    request = SimpleNamespace(
        method=method,
        scheme="https",
        host="api.example.test",
        port=443,
        path="/rpc",
        http_version="HTTP/2",
        headers=Headers((b"content-type", b"application/json"), (b"x-repeat", b"one"), (b"x-repeat", b"two")),
        raw_content=request_body,
        timestamp_start=10.0,
    )
    response = SimpleNamespace(
        status_code=200,
        reason="OK",
        http_version="HTTP/2",
        headers=Headers((b"content-type", b"application/json")),
        raw_content=response_body,
        timestamp_end=10.125,
    )
    return SimpleNamespace(
        id="flow-1",
        request=request,
        response=response,
        server_conn=SimpleNamespace(ip_address=("192.0.2.1", 443)),
        websocket=None,
        error=None,
    )


def addon(tmp_path: Path, per_body=4, total=32, **kwargs):
    sink = Sink()
    store = BodyArtifactStore(tmp_path / "proxy", per_body_limit=per_body, total_limit=total)
    return ProxyCaptureAddon(
        sink,
        store,
        listen_host="127.0.0.1",
        listen_port=9090,
        health_interval=60,
        **kwargs,
    ), sink


def test_ready_describes_honest_coverage_without_pinning_bypass(tmp_path: Path):
    instance, sink = addon(tmp_path)
    instance.running()
    instance.done()
    ready = sink.events[0]
    assert ready["kind"] == "provider.ready"
    assert ready["payload"]["fixture"] is False
    assert ready["payload"]["certificate_pinning_bypass"] is False
    assert "configured_proxy_traffic" in ready["payload"]["coverage"]
    assert sink.events[-1]["kind"] == "provider.stopped"
    assert sink.closed


def test_wireguard_ready_reports_routed_coverage_and_private_config_path(tmp_path: Path):
    instance, sink = addon(
        tmp_path,
        transport="wireguard",
        client_config_path="/private/proxbot.conf",
        advertised_host="192.168.1.23",
    )
    instance.running()
    instance.done()
    ready = sink.events[0]["payload"]
    assert ready["transport"] == "wireguard"
    assert ready["advertised_host"] == "192.168.1.23"
    assert ready["client_config_path"] == "/private/proxbot.conf"
    assert "wireguard_routed_traffic" in ready["coverage"]
    assert "transparent_external_device_capture" in ready["capabilities"]


def test_http2_request_response_are_compatible_network_events(tmp_path: Path):
    instance, sink = addon(tmp_path)
    captured = flow()
    instance.request(captured)
    instance.response(captured)
    request, response = sink.events

    assert request["kind"] == "network.request"
    assert request["payload"]["request_id"] == "flow-1"
    assert request["payload"]["protocol"] == "HTTP/2"
    assert request["payload"]["ip"] == "192.0.2.1"
    assert request["payload"]["reconstructed"] is True
    assert request["payload"]["truncated"] is True
    assert request["payload"]["raw"].endswith("\r\n\r\nhell")
    assert request["raw_ref"]["length"] == 4
    assert request["payload"]["body_bytes"] == 5
    assert request["payload"]["body_bytes_captured"] == 4
    assert request["payload"]["body_bytes_dropped"] == 1
    assert request["payload"]["request_bytes"] == len(
        request["payload"]["raw"].encode("latin-1")
    ) + 1

    assert response["kind"] == "network.response"
    assert response["payload"]["status"] == 200
    assert response["payload"]["duration_ms"] == 125
    assert response["payload"]["raw"].startswith("HTTP/2 200 OK")
    assert response["payload"]["truncated"] is True
    assert response["payload"]["body_bytes"] == 5
    assert response["payload"]["body_bytes_captured"] == 4
    assert response["payload"]["body_bytes_dropped"] == 1
    instance.done()


def test_wireguard_request_prefers_flow_sni_over_cdn_ip(tmp_path: Path):
    instance, sink = addon(tmp_path, transport="wireguard")
    captured = flow()
    captured.request.host = "3.161.119.24"
    captured.request.pretty_host = "3.161.119.24"
    captured.server_conn.sni = "xhqq0u.skadsdkless.appsflyersdk.com"

    instance.request(captured)
    request = sink.events[0]["payload"]

    assert request["host"] == "xhqq0u.skadsdkless.appsflyersdk.com"
    assert request["ip"] == "192.0.2.1"
    assert request["host_source"] == "tls.sni"
    assert request["domain_candidates"] == [
        "xhqq0u.skadsdkless.appsflyersdk.com",
        "3.161.119.24",
    ]
    instance.done()


def test_gzip_response_preserves_wire_artifact_and_emits_decoded_json_view(
    tmp_path: Path,
):
    instance, sink = addon(tmp_path, per_body=4096, total=4096)
    captured = flow(response_body=b"")
    decoded = b'{"balance":"12.34","currency":"USD"}'
    encoded = gzip.compress(decoded)
    captured.response.raw_content = encoded
    captured.response.content = decoded
    captured.response.headers = Headers(
        (b"content-type", b"application/json"),
        (b"content-encoding", b"gzip"),
    )

    instance.response(captured)
    event = sink.events[0]
    response = event["payload"]

    assert response["raw"].endswith(decoded.decode())
    assert response["content_decoded"] is True
    assert response["content_encoding"] == "gzip"
    assert response["media_type"] == "application/json; content-decoded=gzip"
    assert response["body_bytes"] == len(encoded)
    assert response["display_body_bytes"] == len(decoded)
    assert response["response_bytes"] == (
        len(response["raw"].encode("latin-1")) - len(decoded) + len(encoded)
    )
    assert event["raw_ref"]["length"] == len(encoded)
    assert (tmp_path / "proxy/response-bodies.bin").read_bytes() == encoded
    instance.done()


def test_real_mitmproxy_brotli_response_emits_json_not_compressed_bytes(
    tmp_path: Path,
):
    instance, sink = addon(tmp_path, per_body=4096, total=4096)
    captured = flow(response_body=b"")
    decoded = b'{"method":"signTransaction","result":"signed"}'
    captured.response = http.Response.make(
        200,
        decoded,
        {
            "content-type": "application/json; charset=utf-8",
            "content-encoding": "br",
        },
    )
    captured.response.http_version = "HTTP/2.0"
    captured.response.timestamp_end = 10.125
    encoded = captured.response.raw_content
    assert encoded is not None and encoded != decoded

    instance.response(captured)
    event = sink.events[0]
    response = event["payload"]

    assert response["raw"].endswith(decoded.decode())
    assert response["content_decoded"] is True
    assert response["content_encoding"] == "br"
    assert response["media_type"] == (
        "application/json; charset=utf-8; content-decoded=br"
    )
    assert (tmp_path / "proxy/response-bodies.bin").read_bytes() == encoded
    instance.done()


def test_cleartext_request_reports_ip_source_without_inventing_a_domain(
    tmp_path: Path,
):
    instance, sink = addon(tmp_path)
    captured = flow()
    captured.request.host = "192.0.2.1"
    captured.request.pretty_host = "192.0.2.1"

    instance.request(captured)
    request = sink.events[0]["payload"]

    assert request["host"] == "192.0.2.1"
    assert request["host_source"] == "destination.ip"
    assert request["domain_candidates"] == ["192.0.2.1"]
    instance.done()


def test_wire_size_accounts_for_bytes_dropped_by_total_budget(tmp_path: Path):
    instance, sink = addon(tmp_path, per_body=64, total=2)
    instance.request(flow(request_body=b"12345"))
    request = sink.events[0]

    assert request["raw_ref"]["length"] == 2
    assert request["payload"]["body_bytes_dropped"] == 3
    assert request["payload"]["request_bytes"] == len(
        request["payload"]["raw"].encode("latin-1")
    ) + 3
    instance.done()


def test_header_budget_reports_exact_truncation_without_hiding_original_size(
    tmp_path: Path,
):
    instance, sink = addon(tmp_path, per_body=0)
    captured = flow(request_body=b"")
    captured.request.headers = Headers(
        (b"x-large", b"x" * (MAX_RAW_HEADERS + 17))
    )

    instance.request(captured)
    request = sink.events[0]["payload"]

    assert request["header_bytes_dropped"] == len(b"x-large: ") + 17
    assert request["truncated"] is True
    assert request["request_bytes"] == (
        request["captured_raw_bytes"] + request["header_bytes_dropped"]
    )
    instance.done()


def test_connect_websocket_and_tls_metadata(tmp_path: Path):
    instance, sink = addon(tmp_path, per_body=8)
    connect = flow(method="CONNECT", request_body=b"", response_body=b"")
    instance.http_connect(connect)
    instance.http_connected(connect)
    assert sink.events[-2]["payload"]["method"] == "CONNECT"
    assert sink.events[-1]["payload"]["status"] == 200

    message = SimpleNamespace(content=b"websocket payload", from_client=True, type="BINARY")
    connect.websocket = SimpleNamespace(messages=[message])
    instance.websocket_message(connect)
    assert sink.events[-1]["kind"] == "network.websocket"
    assert sink.events[-1]["payload"]["truncated"] is True

    connection = SimpleNamespace(sni="api.example.test", alpn=b"h2", tls_version="TLSv1.3", cipher="TLS_AES_128_GCM_SHA256")
    instance.tls_established_server(SimpleNamespace(conn=connection))
    assert sink.events[-1]["kind"] == "network.tls"
    assert sink.events[-1]["payload"]["alpn"] == "h2"
    assert sink.events[-1]["payload"]["certificate_pinning_bypass"] is False
    instance.done()


def test_health_reports_malformed_and_bounded_artifact_counters(tmp_path: Path):
    instance, sink = addon(tmp_path, per_body=2)
    instance.request(flow(request_body=b"12345"))
    instance.request(SimpleNamespace(id="broken"))
    health = instance.health_payload()
    assert health["received"] == 1
    assert health["malformed"] == 1
    assert health["body_bytes_dropped"] == 3
    assert sink.events[-1]["parse_status"] == "malformed"
    instance.done()

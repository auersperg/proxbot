import asyncio
import socket
import struct
import tempfile
from types import SimpleNamespace

import msgpack

from proxbot_ios_provider import live_provider


async def read_frame(connection):
    header = await asyncio.get_running_loop().sock_recv(connection, 4)
    if not header:
        return None
    size = struct.unpack(">I", header)[0]
    payload = bytearray()
    while len(payload) < size:
        payload.extend(
            await asyncio.get_running_loop().sock_recv(connection, size - len(payload))
        )
    return msgpack.unpackb(payload, raw=False)


def test_live_capture_emits_truthful_contiguous_lifecycle(tmp_path, monkeypatch):
    async def capture_until_cancel(output, udid, count, *args):
        output.write_bytes(b"artifact")
        if output.suffix == ".pcapng" and args:
            packet_callback = args[-1]
            await packet_callback(
                SimpleNamespace(
                    seconds=1_784_730_000,
                    microseconds=123_000,
                    data=b"not-an-ethernet-frame",
                ),
                {
                    "direction": "outbound",
                    "interface": "en0",
                    "process_id": 42,
                    "process_name": "FixtureApp",
                    "packet_bytes": 64,
                    "protocol": "TCP",
                    "source_ip": "192.0.2.1",
                    "destination_ip": "198.51.100.2",
                    "source_port": 50_000,
                    "destination_port": 443,
                },
                {
                    "relative_path": "capture/device.pcapng",
                    "offset": 128,
                    "length": 64,
                    "sha256": "0" * 64,
                },
                b"not-an-ethernet-frame",
            )
        await asyncio.Event().wait()

    monkeypatch.setattr(live_provider, "capture_pcap", capture_until_cancel)
    monkeypatch.setattr(live_provider, "capture_logs", capture_until_cancel)
    monkeypatch.setattr(
        live_provider,
        "extract_protocol_enrichment",
        lambda _frame: {
            "tls_client_hello": {
                "server_name": "auth.privy.io",
                "alpn_protocols": ["h2"],
            },
            "domain_observations": [
                {"name": "auth.privy.io", "source": "tls.sni"}
            ],
        },
    )

    async def run():
        socket_path = tempfile.mktemp(prefix="proxbot-test-", suffix=".sock")
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(socket_path)
        listener.listen(1)
        listener.setblocking(False)
        stop = asyncio.Event()
        task = asyncio.create_task(
            live_provider.run_live_capture(
                socket_path,
                "00000000-0000-0000-0000-000000000001",
                "USB-UDID",
                tmp_path / "capture.pcapng",
                tmp_path / "device.jsonl",
                health_interval=0.01,
                _stop_event=stop,
            )
        )
        connection, _ = await asyncio.get_running_loop().sock_accept(listener)
        connection.setblocking(False)
        # The immediate packet callback deliberately races provider startup.
        # provider.ready must remain sequence zero and the packet must follow.
        events = [await read_frame(connection), await read_frame(connection)]
        stop.set()
        while True:
            event = await read_frame(connection)
            if event is None:
                break
            events.append(event)
        await task
        connection.close()
        listener.close()
        return events

    events = asyncio.run(run())
    assert [event["sequence"] for event in events] == list(range(len(events)))
    assert [event["kind"] for event in events] == [
        "provider.ready",
        "network.packet",
        "artifact.pcap",
        "artifact.syslog",
        "provider.stopped",
    ]
    ready = events[0]
    assert ready["payload"]["fixture"] is False
    assert ready["payload"]["application_plaintext"] is False
    assert ready["payload"]["tls_decryption"] is False
    assert events[1]["process_name"] == "FixtureApp"
    assert events[1]["payload"]["destination_port"] == 443
    assert events[1]["payload"]["host"] == "auth.privy.io"
    assert events[1]["payload"]["host_source"] == "tls.sni"
    assert events[1]["payload"]["domain_candidates"] == ["auth.privy.io"]
    assert events[1]["payload"]["protocol_enrichment"]["tls_client_hello"][
        "alpn_protocols"
    ] == ["h2"]
    assert events[1]["raw_ref"] == {
        "relative_path": "capture/device.pcapng",
        "offset": 128,
        "length": 64,
        "sha256": "0" * 64,
    }
    assert events[1]["source_time_ns"] == 1_784_730_000_123_000_000
    assert events[-1]["payload"]["reason"] == "requested"


def test_dns_ttl_cache_preserves_candidates_and_expires_them() -> None:
    cache = live_provider._DnsTtlCache()
    cache.observe(
        {
            "dns": {
                "kind": "response",
                "address_records": [
                    {"name": "api.example", "address": "203.0.113.8", "ttl": 30},
                    {"name": "edge.example", "address": "203.0.113.8", "ttl": 10},
                ],
            }
        },
        100.0,
    )

    assert cache.names_for("203.0.113.8", 101.0) == [
        "api.example",
        "edge.example",
    ]
    assert cache.names_for("203.0.113.8", 111.0) == ["api.example"]
    assert cache.names_for("203.0.113.8", 131.0) == []


def test_dns_ttl_zero_removes_only_the_matching_name() -> None:
    cache = live_provider._DnsTtlCache()
    cache.observe(
        {
            "dns": {
                "kind": "response",
                "address_records": [
                    {"name": "one.example", "address": "2001:db8::8", "ttl": 60},
                    {"name": "two.example", "address": "2001:db8::8", "ttl": 60},
                ],
            }
        },
        10.0,
    )
    cache.observe(
        {
            "dns": {
                "kind": "response",
                "address_records": [
                    {"name": "one.example", "address": "2001:db8::8", "ttl": 0}
                ],
            }
        },
        11.0,
    )

    assert cache.names_for("2001:db8::8", 12.0) == ["two.example"]

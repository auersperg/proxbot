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
                SimpleNamespace(seconds=1_784_730_000, microseconds=123_000),
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
            )
        await asyncio.Event().wait()

    monkeypatch.setattr(live_provider, "capture_pcap", capture_until_cancel)
    monkeypatch.setattr(live_provider, "capture_logs", capture_until_cancel)

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
    assert events[1]["source_time_ns"] == 1_784_730_000_123_000_000
    assert events[-1]["payload"]["reason"] == "requested"

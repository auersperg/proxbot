import asyncio
import socket
import struct
import tempfile

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
    async def capture_until_cancel(output, udid, count):
        output.write_bytes(b"artifact")
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
        events = [await read_frame(connection)]
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
        "artifact.pcap",
        "artifact.syslog",
        "provider.stopped",
    ]
    ready = events[0]
    assert ready["payload"]["fixture"] is False
    assert ready["payload"]["application_plaintext"] is False
    assert ready["payload"]["tls_decryption"] is False
    assert events[-1]["payload"]["reason"] == "requested"

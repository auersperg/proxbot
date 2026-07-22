import socket
import struct
import os
import uuid
from pathlib import Path

import msgpack

from proxbot_proxy_provider.events import EventSink
from proxbot_proxy_provider.protocol import encode_frame


def test_frame_is_big_endian_versioned_messagepack():
    frame = encode_frame({"schema_version": 1, "kind": "provider.ready"})
    size = struct.unpack(">I", frame[:4])[0]
    assert size == len(frame) - 4
    assert msgpack.unpackb(frame[4:], raw=False) == {"schema_version": 1, "kind": "provider.ready"}


def test_event_sink_preserves_sequence_and_envelope(tmp_path: Path):
    socket_path = Path(f"/tmp/pb-{os.getpid()}-{uuid.uuid4().hex[:8]}.sock")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
        server.bind(str(socket_path))
        server.listen(1)
        sink = EventSink(socket_path, "00000000-0000-0000-0000-000000000001", queue_size=8)
        connection, _ = server.accept()
        with connection:
            assert sink.emit("provider.ready", {"fixture": False})
            sink.close()
            header = connection.recv(4)
            size = struct.unpack(">I", header)[0]
            payload = b""
            while len(payload) < size:
                payload += connection.recv(size - len(payload))
    socket_path.unlink(missing_ok=True)
    event = msgpack.unpackb(payload, raw=False)
    assert event["schema_version"] == 1
    assert event["provider_id"] == "proxy-mitm"
    assert event["session_id"].endswith("0001")
    assert event["sequence"] == 0
    assert event["evidence"] == "observed"

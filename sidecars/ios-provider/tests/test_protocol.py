import socket
import struct

import msgpack

from proxbot_ios_provider.protocol import encode_frame, send_frame


def test_send_frame_uses_big_endian_length_prefix():
    left, right = socket.socketpair()
    try:
        send_frame(left, {"schema_version": 1, "kind": "provider.hello"})
        size = struct.unpack(">I", right.recv(4))[0]
        payload = right.recv(size)
        assert msgpack.unpackb(payload, raw=False) == {
            "schema_version": 1,
            "kind": "provider.hello",
        }
    finally:
        left.close()
        right.close()


def test_encode_frame_matches_socket_protocol():
    frame = encode_frame({"kind": "provider.health", "received": 7})
    size = struct.unpack(">I", frame[:4])[0]
    assert size == len(frame) - 4
    assert msgpack.unpackb(frame[4:], raw=False)["received"] == 7

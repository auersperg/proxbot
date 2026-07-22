import socket
import struct

import msgpack

from tracelab_ios_provider.protocol import send_frame


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

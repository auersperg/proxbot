import socket
import struct
from typing import Any

import msgpack


def encode_frame(message: dict[str, Any]) -> bytes:
    payload = msgpack.packb(message, use_bin_type=True)
    return struct.pack(">I", len(payload)) + payload


def send_frame(connection: socket.socket, message: dict[str, Any]) -> None:
    connection.sendall(encode_frame(message))

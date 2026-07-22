from __future__ import annotations

import socket
import struct
from typing import Any

import msgpack

MAX_FRAME_BYTES = 16 * 1024 * 1024


def encode_frame(message: dict[str, Any]) -> bytes:
    payload = msgpack.packb(message, use_bin_type=True)
    if len(payload) > MAX_FRAME_BYTES:
        raise ValueError(f"provider event exceeds {MAX_FRAME_BYTES} bytes")
    return struct.pack(">I", len(payload)) + payload


def send_frame(connection: socket.socket, message: dict[str, Any]) -> None:
    connection.sendall(encode_frame(message))

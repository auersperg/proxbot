import socket
import struct
from typing import Any

import msgpack


def send_frame(connection: socket.socket, message: dict[str, Any]) -> None:
    payload = msgpack.packb(message, use_bin_type=True)
    connection.sendall(struct.pack(">I", len(payload)) + payload)

from __future__ import annotations

import queue
import socket
import os
import struct
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import __version__
from .protocol import send_frame


@dataclass
class SinkCounters:
    accepted: int = 0
    sent: int = 0
    dropped: int = 0
    send_errors: int = 0


class EventSink:
    """Bounded non-blocking producer with a single ordered MessagePack sender."""

    def __init__(self, socket_path: Path, session_id: str, queue_size: int = 4096):
        if queue_size < 1:
            raise ValueError("queue size must be positive")
        self.session_id = session_id
        self.counters = SinkCounters()
        self._sequence = 0
        self._lock = threading.Lock()
        self._queue: queue.Queue[dict[str, Any] | None] = queue.Queue(queue_size)
        self._connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._connection.connect(str(socket_path))
        self._verify_peer()
        self._thread = threading.Thread(target=self._send_loop, name="proxbot-proxy-events", daemon=True)
        self._thread.start()

    def _verify_peer(self) -> None:
        if hasattr(self._connection, "getpeereid"):
            uid, _ = self._connection.getpeereid()  # type: ignore[attr-defined]
        elif hasattr(socket, "SO_PEERCRED"):
            credentials = self._connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
            _, uid, _ = struct.unpack("3i", credentials)
        else:
            return
        if uid != os.getuid():
            self._connection.close()
            raise PermissionError("proxy event socket peer is owned by a different user")

    @property
    def queue_depth(self) -> int:
        return self._queue.qsize()

    def emit(
        self,
        kind: str,
        payload: dict[str, Any],
        *,
        raw_ref: dict[str, Any] | None = None,
        parse_status: str = "parsed",
    ) -> bool:
        now = time.time_ns()
        with self._lock:
            sequence = self._sequence
            self._sequence += 1
        event = {
            "schema_version": 1,
            "provider_id": "proxy-mitm",
            "provider_version": __version__,
            "session_id": self.session_id,
            "sequence": sequence,
            "source_time_ns": now,
            "host_time_ns": now,
            "monotonic_time_ns": time.monotonic_ns(),
            "device_id": None,
            "process_id": None,
            "process_name": None,
            "evidence": "observed",
            "kind": kind,
            "payload": payload,
            "raw_ref": raw_ref,
            "parse_status": parse_status,
        }
        try:
            self._queue.put_nowait(event)
            self.counters.accepted += 1
            return True
        except queue.Full:
            self.counters.dropped += 1
            return False

    def _send_loop(self) -> None:
        while True:
            event = self._queue.get()
            try:
                if event is None:
                    return
                send_frame(self._connection, event)
                self.counters.sent += 1
            except OSError:
                self.counters.send_errors += 1
                self.counters.dropped += 1
            finally:
                self._queue.task_done()

    def close(self, timeout: float = 5.0) -> None:
        deadline = time.monotonic() + timeout
        while True:
            try:
                self._queue.put(None, timeout=max(0.01, deadline - time.monotonic()))
                break
            except queue.Full:
                if time.monotonic() >= deadline:
                    self.counters.dropped += self._queue.qsize()
                    break
        self._thread.join(max(0.0, deadline - time.monotonic()))
        self._connection.close()

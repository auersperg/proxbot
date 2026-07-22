from __future__ import annotations

import hashlib
import os
import threading
from dataclasses import dataclass
from pathlib import Path

from .secure_output import ensure_owner_directory, open_append_owner_only


@dataclass(frozen=True)
class ArtifactResult:
    ref: dict[str, object] | None
    truncated: bool
    dropped_bytes: int


class BodyArtifactStore:
    """Append-only, owner-only bounded request/response body evidence."""

    def __init__(self, root: Path, per_body_limit: int, total_limit: int):
        if per_body_limit < 0 or total_limit < 0:
            raise ValueError("artifact limits must be non-negative")
        self.root = ensure_owner_directory(root)
        self.per_body_limit = per_body_limit
        self.total_limit = total_limit
        self._written = 0
        self._lock = threading.Lock()
        self._descriptors = {
            "request": open_append_owner_only(root / "request-bodies.bin"),
            "response": open_append_owner_only(root / "response-bodies.bin"),
            "websocket": open_append_owner_only(root / "websocket-messages.bin"),
        }

    @property
    def written(self) -> int:
        with self._lock:
            return self._written

    def append(self, channel: str, body: bytes) -> ArtifactResult:
        if channel not in self._descriptors:
            raise ValueError(f"unsupported artifact channel: {channel}")
        with self._lock:
            available = max(0, self.total_limit - self._written)
            accepted = body[: min(self.per_body_limit, available)]
            dropped = len(body) - len(accepted)
            if not accepted:
                return ArtifactResult(None, bool(body), dropped)
            descriptor = self._descriptors[channel]
            offset = os.lseek(descriptor, 0, os.SEEK_END)
            view = memoryview(accepted)
            while view:
                count = os.write(descriptor, view)
                view = view[count:]
            os.fsync(descriptor)
            self._written += len(accepted)
            relative_path = f"proxy/{channel}-bodies.bin"
            return ArtifactResult(
                {
                    "relative_path": relative_path,
                    "offset": offset,
                    "length": len(accepted),
                    "sha256": hashlib.sha256(accepted).hexdigest(),
                },
                dropped > 0,
                dropped,
            )

    def close(self) -> None:
        for descriptor in self._descriptors.values():
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        self._descriptors.clear()

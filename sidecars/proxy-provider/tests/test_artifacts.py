import os
import stat
from pathlib import Path

import pytest

from proxbot_proxy_provider.artifacts import BodyArtifactStore
from proxbot_proxy_provider.secure_output import ensure_owner_directory


def mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


def test_body_store_enforces_per_body_and_total_bounds_with_hashes(tmp_path: Path):
    root = tmp_path / "proxy"
    store = BodyArtifactStore(root, per_body_limit=4, total_limit=6)
    first = store.append("request", b"abcdef")
    second = store.append("response", b"uvwxyz")
    store.close()

    assert first.truncated and first.dropped_bytes == 2
    assert first.ref == {
        "relative_path": "proxy/request-bodies.bin",
        "offset": 0,
        "length": 4,
        "sha256": "88d4266fd4e6338d13b845fcf289579d209c897823b9217da3e161936f031589",
    }
    assert second.truncated and second.ref and second.ref["length"] == 2
    assert (root / "request-bodies.bin").read_bytes() == b"abcd"
    assert (root / "response-bodies.bin").read_bytes() == b"uv"
    assert mode(root) == 0o700
    assert mode(root / "request-bodies.bin") == 0o600


def test_owner_directory_rejects_symlink(tmp_path: Path):
    target = tmp_path / "target"
    target.mkdir()
    link = tmp_path / "link"
    link.symlink_to(target, target_is_directory=True)
    with pytest.raises(ValueError, match="symlinks|real directory"):
        ensure_owner_directory(link)

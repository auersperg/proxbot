import socket
import os
import uuid
from pathlib import Path

import pytest

from proxbot_proxy_provider.cli import build_parser, ca_info, probe, validate_start


def test_probe_reports_stable_runtime_and_honest_capabilities():
    result = probe()
    assert result["available"] is True
    assert result["mitmproxy_version"] == "12.2.3"
    assert result["certificate_pinning_bypass"] is False
    assert "http_2" in result["capabilities"]


def test_ca_info_never_reports_private_key(tmp_path: Path):
    result = ca_info(tmp_path / "conf")
    assert result["initialized"] is False
    assert result["private_key_exposed"] is False
    assert result["sha256"] is None


def test_start_validation_requires_explicit_remote_opt_in(tmp_path: Path):
    socket_dir = Path(f"/tmp/pb-{os.getpid()}-{uuid.uuid4().hex[:6]}")
    socket_dir.mkdir(mode=0o700)
    socket_path = socket_dir / "events.sock"
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(socket_path))
    os.chmod(socket_path, 0o600)
    parser = build_parser()
    arguments = parser.parse_args([
        "start", "--socket", str(socket_path), "--session-id", "00000000-0000-0000-0000-000000000001",
        "--artifact-root", str(tmp_path / "artifacts"), "--confdir", str(tmp_path / "ca"),
        "--listen-host", "0.0.0.0",
    ])
    try:
        with pytest.raises(SystemExit, match="non-loopback"):
            validate_start(arguments)
    finally:
        server.close()
        socket_path.unlink(missing_ok=True)
        socket_dir.rmdir()

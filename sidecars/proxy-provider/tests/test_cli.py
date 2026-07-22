import socket
import os
import uuid
from pathlib import Path
from unittest.mock import patch

import pytest
from mitmproxy.tools import main as mitmproxy_main

from proxbot_proxy_provider.cli import build_parser, ca_info, probe, start, validate_start


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


def test_start_runs_embedded_mitmdump_with_bundled_addon(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    socket_dir = Path(f"/tmp/pb-{os.getpid()}-{uuid.uuid4().hex[:6]}")
    socket_dir.mkdir(mode=0o700)
    socket_path = socket_dir / "events.sock"
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(socket_path))
    os.chmod(socket_path, 0o600)
    artifact_root = tmp_path / "artifacts"
    confdir = tmp_path / "ca"
    arguments = build_parser().parse_args([
        "start", "--socket", str(socket_path), "--session-id", "00000000-0000-0000-0000-000000000001",
        "--artifact-root", str(artifact_root), "--confdir", str(confdir),
        "--listen-host", "0.0.0.0", "--listen-port", "19090", "--allow-remote",
    ])
    calls: list[list[str]] = []
    monkeypatch.setattr(mitmproxy_main, "mitmdump", lambda argv: calls.append(argv))

    try:
        with patch.dict(os.environ, {}, clear=False):
            start(arguments)
            assert os.environ["PROXBOT_PROXY_SOCKET"] == str(socket_path)
            assert os.environ["PROXBOT_PROXY_LISTEN_HOST"] == "0.0.0.0"
            assert os.environ["PROXBOT_PROXY_LISTEN_PORT"] == "19090"
        assert len(calls) == 1
        command = calls[0]
        assert command[0] == "--listen-host"
        assert command[command.index("--listen-port") + 1] == "19090"
        addon = Path(command[command.index("-s") + 1])
        assert addon.name == "mitm_addon.py"
        assert addon.is_file()
        assert artifact_root.is_dir()
        assert confdir.is_dir()
    finally:
        server.close()
        socket_path.unlink(missing_ok=True)
        socket_dir.rmdir()

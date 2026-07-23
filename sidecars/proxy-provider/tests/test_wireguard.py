import json
import os
import stat
from pathlib import Path

import pytest

from proxbot_proxy_provider.wireguard import prepare_wireguard


def test_prepare_wireguard_creates_stable_owner_only_state_and_importable_client(tmp_path: Path):
    root = tmp_path / "private"
    state = root / "server.json"
    client = root / "proxbot.conf"

    result = prepare_wireguard(state, client, "192.168.1.23", 51820)
    first_state = json.loads(state.read_text())
    first_client = client.read_text()
    second = prepare_wireguard(state, client, "192.168.1.24", 51821)

    assert result["client_config_path"] == str(client)
    assert second["listen_port"] == 51821
    assert json.loads(state.read_text()) == first_state
    assert stat.S_IMODE(os.stat(root).st_mode) == 0o700
    assert stat.S_IMODE(os.stat(state).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(client).st_mode) == 0o600
    assert "[Interface]" in first_client
    assert "Address = 10.0.0.1/32" in first_client
    assert "DNS = 10.0.0.53" in first_client
    assert "AllowedIPs = 0.0.0.0/0" in first_client
    assert "Endpoint = 192.168.1.23:51820" in first_client
    assert "Endpoint = 192.168.1.24:51821" in client.read_text()
    assert "PersistentKeepalive = 25" in first_client


def test_prepare_wireguard_formats_ipv6_endpoint(tmp_path: Path):
    client = tmp_path / "private" / "proxbot.conf"
    prepare_wireguard(tmp_path / "private" / "server.json", client, "fe80::1", 51820)
    assert "Endpoint = [fe80::1]:51820" in client.read_text()


def test_prepare_wireguard_rejects_group_readable_existing_secret(tmp_path: Path):
    root = tmp_path / "private"
    root.mkdir(mode=0o700)
    state = root / "server.json"
    state.write_text('{"server_key":"x","client_key":"y"}')
    os.chmod(state, 0o644)
    with pytest.raises(ValueError, match="group/world"):
        prepare_wireguard(state, root / "proxbot.conf", "192.168.1.23", 51820)


def test_prepare_wireguard_rejects_invalid_existing_state(tmp_path: Path):
    root = tmp_path / "private"
    root.mkdir(mode=0o700)
    state = root / "server.json"
    state.write_text('{"server_key":"eA==","client_key":"eQ=="}')
    os.chmod(state, 0o600)
    with pytest.raises(ValueError, match="exactly 32 bytes"):
        prepare_wireguard(state, root / "proxbot.conf", "192.168.1.23", 51820)

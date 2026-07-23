from __future__ import annotations

import base64
import json
import os
import stat
import tempfile
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat, PublicFormat

from .secure_output import ensure_owner_directory

WIREGUARD_CLIENT_ADDRESS = "10.0.0.1/32"
WIREGUARD_DNS_ADDRESS = "10.0.0.53"
WIREGUARD_ALLOWED_IPS = "0.0.0.0/0"


def _private_key() -> str:
    key = X25519PrivateKey.generate().private_bytes(
        Encoding.Raw,
        PrivateFormat.Raw,
        NoEncryption(),
    )
    return base64.b64encode(key).decode("ascii")


def _decode_private_key(value: Any, field: str) -> bytes:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a base64 string")
    try:
        decoded = base64.b64decode(value, validate=True)
    except ValueError as error:
        raise ValueError(f"{field} is not valid base64") from error
    if len(decoded) != 32:
        raise ValueError(f"{field} must contain exactly 32 bytes")
    return decoded


def _owner_secret(path: Path) -> None:
    metadata = os.lstat(path)
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"WireGuard secret is not a regular file: {path}")
    if metadata.st_uid != os.getuid():
        raise ValueError(f"WireGuard secret is not owned by the current user: {path}")
    if stat.S_IMODE(metadata.st_mode) & 0o077:
        raise ValueError(f"WireGuard secret must not grant group/world access: {path}")


def _atomic_secret(path: Path, content: bytes) -> None:
    ensure_owner_directory(path.parent)
    if path.exists() or path.is_symlink():
        _owner_secret(path)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb", closefd=True) as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            os.close(descriptor)
        except OSError:
            pass
        Path(temporary).unlink(missing_ok=True)


def _load_or_create_state(path: Path) -> dict[str, str]:
    ensure_owner_directory(path.parent)
    if path.exists() or path.is_symlink():
        _owner_secret(path)
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"invalid WireGuard state: {error}") from error
        if not isinstance(state, dict):
            raise ValueError("WireGuard state must be a JSON object")
        server_key = state.get("server_key")
        client_key = state.get("client_key")
        _decode_private_key(server_key, "server_key")
        _decode_private_key(client_key, "client_key")
        return {"server_key": server_key, "client_key": client_key}

    state = {"server_key": _private_key(), "client_key": _private_key()}
    _atomic_secret(
        path,
        (json.dumps(state, separators=(",", ":"), sort_keys=True) + "\n").encode(),
    )
    return state


def _endpoint(host: str, port: int) -> str:
    rendered = host.strip()
    if not rendered:
        raise ValueError("WireGuard advertised host must not be empty")
    if ":" in rendered and not rendered.startswith("["):
        rendered = f"[{rendered}]"
    return f"{rendered}:{port}"


def prepare_wireguard(
    state_path: Path,
    client_config_path: Path,
    advertised_host: str,
    listen_port: int,
) -> dict[str, str | int]:
    if not 1 <= listen_port <= 65535:
        raise ValueError("WireGuard listen port must be between 1 and 65535")
    state = _load_or_create_state(state_path)
    server_private = X25519PrivateKey.from_private_bytes(
        _decode_private_key(state["server_key"], "server_key")
    )
    server_public = base64.b64encode(
        server_private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    ).decode("ascii")
    client = "\n".join(
        [
            "[Interface]",
            f"PrivateKey = {state['client_key']}",
            f"Address = {WIREGUARD_CLIENT_ADDRESS}",
            f"DNS = {WIREGUARD_DNS_ADDRESS}",
            "",
            "[Peer]",
            f"PublicKey = {server_public}",
            f"AllowedIPs = {WIREGUARD_ALLOWED_IPS}",
            f"Endpoint = {_endpoint(advertised_host, listen_port)}",
            "PersistentKeepalive = 25",
            "",
        ]
    )
    _atomic_secret(client_config_path, client.encode("ascii"))
    return {
        "state_path": str(state_path),
        "client_config_path": str(client_config_path),
        "advertised_host": advertised_host,
        "listen_port": listen_port,
        "allowed_ips": WIREGUARD_ALLOWED_IPS,
    }

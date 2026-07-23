from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import ssl
import stat
import sys
import uuid
from pathlib import Path
from typing import Any

from . import __version__
from .secure_output import ensure_owner_directory, validate_owner_directory
from .wireguard import prepare_wireguard


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="proxbot-proxy-provider")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("probe", help="Report provider and mitmproxy capabilities")

    ca = commands.add_parser("ca-info", help="Report public CA paths and fingerprint")
    ca.add_argument("--confdir", type=Path, required=True)

    start = commands.add_parser("start", help="Run the production proxy provider")
    start.add_argument("--socket", type=Path, required=True)
    start.add_argument("--session-id", required=True)
    start.add_argument("--artifact-root", type=Path, required=True)
    start.add_argument("--confdir", type=Path, required=True)
    start.add_argument("--listen-host", default="127.0.0.1")
    start.add_argument("--listen-port", type=int, default=9090)
    start.add_argument("--mode", choices=("regular", "wireguard", "transparent", "socks5"), default="regular")
    start.add_argument("--advertise-host")
    start.add_argument("--wireguard-state", type=Path)
    start.add_argument("--wireguard-client-config", type=Path)
    start.add_argument("--body-limit", type=int, default=1024 * 1024)
    start.add_argument("--total-body-limit", type=int, default=512 * 1024 * 1024)
    start.add_argument("--queue-size", type=int, default=4096)
    start.add_argument("--health-interval", type=float, default=1.0)
    start.add_argument("--allow-remote", action="store_true")
    return parser


def _json(value: dict[str, Any]) -> None:
    print(json.dumps(value, separators=(",", ":"), sort_keys=True))


def probe() -> dict[str, Any]:
    import mitmproxy.version

    executable = shutil.which("mitmdump")
    return {
        "available": True,
        "provider": "proxy-mitm",
        "provider_version": __version__,
        "mitmproxy_version": mitmproxy.version.VERSION,
        "mitmdump": executable or "embedded",
        "schema_version": 1,
        "capabilities": [
            "http_connect",
            "http_1_1",
            "http_2",
            "websocket",
            "tls_metadata",
            "bounded_body_artifacts",
            "wireguard_server",
            "transparent_external_device_capture",
        ],
        "certificate_pinning_bypass": False,
    }


def ca_info(confdir: Path) -> dict[str, Any]:
    certificate = confdir / "mitmproxy-ca-cert.pem"
    der_certificate = confdir / "mitmproxy-ca-cert.cer"
    result: dict[str, Any] = {
        "initialized": certificate.is_file(),
        "confdir": str(confdir),
        "certificate_pem": str(certificate),
        "certificate_der": str(der_certificate),
        "private_key_exposed": False,
        "certificate_pinning_bypass": False,
    }
    if certificate.is_file():
        pem = certificate.read_text(encoding="ascii")
        der = ssl.PEM_cert_to_DER_cert(pem)
        result["sha256"] = hashlib.sha256(der).hexdigest()
    else:
        result["sha256"] = None
    return result


def validate_start(arguments: argparse.Namespace) -> None:
    if not 1 <= arguments.listen_port <= 65535:
        raise SystemExit("--listen-port must be between 1 and 65535")
    if arguments.body_limit < 0 or arguments.total_body_limit < 0:
        raise SystemExit("body limits must be non-negative")
    if arguments.body_limit > 8 * 1024 * 1024:
        raise SystemExit("--body-limit must not exceed 8 MiB")
    if arguments.queue_size < 1 or arguments.queue_size > 65536:
        raise SystemExit("--queue-size must be between 1 and 65536")
    if arguments.health_interval <= 0:
        raise SystemExit("--health-interval must be positive")
    try:
        uuid.UUID(arguments.session_id)
    except (ValueError, AttributeError) as error:
        raise SystemExit("--session-id must be a UUID") from error
    if len(os.fsencode(arguments.socket)) > 100:
        raise SystemExit("--socket path must not exceed 100 bytes")
    if arguments.socket.is_symlink() or not arguments.socket.is_socket():
        raise SystemExit(f"--socket is not a Unix socket: {arguments.socket}")
    socket_metadata = os.lstat(arguments.socket)
    if socket_metadata.st_uid != os.getuid() or stat.S_IMODE(socket_metadata.st_mode) & 0o077:
        raise SystemExit("--socket must be owned by the current user with no group/world access")
    try:
        validate_owner_directory(arguments.socket.parent)
    except (OSError, ValueError) as error:
        raise SystemExit(f"--socket parent is not owner-only: {error}") from error
    if arguments.listen_host not in {"127.0.0.1", "::1", "localhost"} and not arguments.allow_remote:
        raise SystemExit("non-loopback listeners require --allow-remote")
    if arguments.mode == "wireguard":
        if arguments.wireguard_state is None:
            raise SystemExit("--wireguard-state is required in wireguard mode")
        if arguments.wireguard_client_config is None:
            raise SystemExit("--wireguard-client-config is required in wireguard mode")
        if not arguments.advertise_host:
            raise SystemExit("--advertise-host is required in wireguard mode")


def start(arguments: argparse.Namespace) -> None:
    validate_start(arguments)
    ensure_owner_directory(arguments.artifact_root)
    ensure_owner_directory(arguments.confdir)
    wireguard = None
    if arguments.mode == "wireguard":
        wireguard = prepare_wireguard(
            arguments.wireguard_state,
            arguments.wireguard_client_config,
            arguments.advertise_host,
            arguments.listen_port,
        )
    addon = Path(__file__).with_name("mitm_addon.py")
    environment = os.environ.copy()
    environment.update(
        {
            "PROXBOT_PROXY_SOCKET": str(arguments.socket),
            "PROXBOT_PROXY_SESSION_ID": arguments.session_id,
            "PROXBOT_PROXY_ARTIFACT_ROOT": str(arguments.artifact_root),
            "PROXBOT_PROXY_LISTEN_HOST": arguments.listen_host,
            "PROXBOT_PROXY_LISTEN_PORT": str(arguments.listen_port),
            "PROXBOT_PROXY_BODY_LIMIT": str(arguments.body_limit),
            "PROXBOT_PROXY_TOTAL_BODY_LIMIT": str(arguments.total_body_limit),
            "PROXBOT_PROXY_QUEUE_SIZE": str(arguments.queue_size),
            "PROXBOT_PROXY_HEALTH_INTERVAL": str(arguments.health_interval),
            "PROXBOT_PROXY_MODE": arguments.mode,
            "PROXBOT_PROXY_WIREGUARD_CLIENT_CONFIG": (
                str(arguments.wireguard_client_config)
                if arguments.wireguard_client_config is not None
                else ""
            ),
            "PROXBOT_PROXY_ADVERTISE_HOST": arguments.advertise_host or "",
        }
    )
    mode = arguments.mode
    if wireguard is not None:
        mode = (
            f"wireguard:{arguments.wireguard_state}"
            f"@{arguments.listen_host}:{arguments.listen_port}"
        )
    command = [
        "--mode", mode,
        "--set", f"confdir={arguments.confdir}",
        "--set", "termlog_verbosity=error",
        "-s", str(addon),
    ]
    if wireguard is None:
        command[0:0] = [
            "--listen-host",
            arguments.listen_host,
            "--listen-port",
            str(arguments.listen_port),
        ]
    # Keep the proxy runnable both from a uv checkout and from the bundled
    # PyInstaller sidecar.  The console-script executable is not present inside
    # a one-file bundle, while mitmproxy's supported Python entry point is.
    os.environ.update(environment)
    from mitmproxy.tools.main import mitmdump

    mitmdump(command)


def main() -> None:
    arguments = build_parser().parse_args()
    if arguments.command == "probe":
        _json(probe())
    elif arguments.command == "ca-info":
        _json(ca_info(arguments.confdir))
    else:
        start(arguments)


if __name__ == "__main__":
    main()

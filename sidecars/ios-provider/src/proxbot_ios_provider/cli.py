import argparse
import asyncio
import json
import os
import socket
from pathlib import Path

import frida

from .fake import fake_events
from .frida_provider import runtime_probe, target_preflight, usb_preflight
from .log_provider import capture_logs
from .live_provider import run_live_capture
from .device_provider import device_preflight
from .pcap_provider import capture_pcap


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="proxbot-ios-provider")
    subcommands = parser.add_subparsers(dest="command", required=True)

    fake = subcommands.add_parser("fake", help=argparse.SUPPRESS)
    fake.add_argument("--socket", required=True)
    fake.add_argument("--session-id", required=True)
    fake.add_argument("--count", type=int, default=30)

    subcommands.add_parser("probe", help="Report bundled provider capabilities")
    subcommands.add_parser("frida-preflight")
    frida_target = subcommands.add_parser(
        "frida-target-preflight",
        help="Test whether a running iOS application can be attached",
    )
    frida_target.add_argument("--bundle-id", required=True)
    frida_target.add_argument("--device-id")

    device = subcommands.add_parser("device-preflight")
    device.add_argument("--udid")

    pcap = subcommands.add_parser("pcap-capture")
    pcap.add_argument("--out", required=True)
    pcap.add_argument("--udid")
    pcap.add_argument("--count", type=int, default=-1)

    logs = subcommands.add_parser("log-capture")
    logs.add_argument("--out", required=True)
    logs.add_argument("--udid")
    logs.add_argument("--count", type=int, default=-1)

    live = subcommands.add_parser("live-capture")
    live.add_argument("--socket", required=True)
    live.add_argument("--session-id", required=True)
    live.add_argument("--udid", required=True)
    live.add_argument("--pcap-out", required=True)
    live.add_argument("--log-out", required=True)
    live.add_argument("--health-interval", type=float, default=1.0)
    live.add_argument("--providers", default="pcap,syslog")
    return parser


def main() -> None:
    arguments = build_parser().parse_args()
    if arguments.command == "probe":
        print(json.dumps(runtime_probe(frida), separators=(",", ":")))
        return

    if arguments.command == "frida-preflight":
        print(json.dumps(usb_preflight(frida), separators=(",", ":")))
        return

    if arguments.command == "frida-target-preflight":
        print(
            json.dumps(
                target_preflight(frida, arguments.bundle_id, arguments.device_id),
                separators=(",", ":"),
            )
        )
        return

    if arguments.command == "device-preflight":
        result = asyncio.run(device_preflight(arguments.udid))
        print(json.dumps(result, separators=(",", ":")))
        return

    if arguments.command == "pcap-capture":
        if arguments.count == 0 or arguments.count < -1:
            raise SystemExit("--count must be -1 or a positive integer")
        result = asyncio.run(
            capture_pcap(Path(arguments.out), arguments.udid, arguments.count)
        )
        print(json.dumps(result, separators=(",", ":")))
        return

    if arguments.command == "log-capture":
        if arguments.count == 0 or arguments.count < -1:
            raise SystemExit("--count must be -1 or a positive integer")
        result = asyncio.run(
            capture_logs(Path(arguments.out), arguments.udid, arguments.count)
        )
        print(json.dumps(result, separators=(",", ":")))
        return

    if arguments.command == "live-capture":
        if arguments.health_interval <= 0:
            raise SystemExit("--health-interval must be positive")
        asyncio.run(
            run_live_capture(
                Path(arguments.socket),
                arguments.session_id,
                arguments.udid,
                Path(arguments.pcap_out),
                Path(arguments.log_out),
                arguments.health_interval,
                tuple(filter(None, arguments.providers.split(","))),
            )
        )
        return

    if arguments.command == "fake":
        if os.environ.get("PROXBOT_ENABLE_TEST_PROVIDER") != "1":
            raise SystemExit("test provider is disabled")
        if arguments.count < 1 or arguments.count > 10_000:
            raise SystemExit("--count must be between 1 and 10000")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.connect(arguments.socket)
            for event in fake_events(arguments.session_id, arguments.count):
                from .protocol import send_frame
                send_frame(connection, event)
        return
    raise SystemExit(f"unsupported provider command: {arguments.command}")

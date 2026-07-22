import argparse
import asyncio
import json
import socket
from pathlib import Path

import frida

from .fake import fake_events
from .frida_provider import usb_preflight
from .log_provider import capture_logs
from .device_provider import device_preflight
from .pcap_provider import capture_pcap
from .protocol import send_frame


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="proxbot-ios-provider")
    subcommands = parser.add_subparsers(dest="command", required=True)

    fake = subcommands.add_parser("fake")
    fake.add_argument("--socket", required=True)
    fake.add_argument("--session-id", required=True)
    fake.add_argument("--count", type=int, default=30)

    subcommands.add_parser("frida-preflight")

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
    return parser


def main() -> None:
    arguments = build_parser().parse_args()
    if arguments.command == "frida-preflight":
        print(json.dumps(usb_preflight(frida), separators=(",", ":")))
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

    if arguments.count < 1 or arguments.count > 10_000:
        raise SystemExit("--count must be between 1 and 10000")

    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.connect(arguments.socket)
        for event in fake_events(arguments.session_id, arguments.count):
            send_frame(connection, event)

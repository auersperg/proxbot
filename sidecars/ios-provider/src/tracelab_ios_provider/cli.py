import argparse
import json
import socket

import frida

from .fake import fake_events
from .frida_provider import usb_preflight
from .protocol import send_frame


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tracelab-ios-provider")
    subcommands = parser.add_subparsers(dest="command", required=True)

    fake = subcommands.add_parser("fake")
    fake.add_argument("--socket", required=True)
    fake.add_argument("--session-id", required=True)
    fake.add_argument("--count", type=int, default=30)

    subcommands.add_parser("frida-preflight")
    return parser


def main() -> None:
    arguments = build_parser().parse_args()
    if arguments.command == "frida-preflight":
        print(json.dumps(usb_preflight(frida), separators=(",", ":")))
        return

    if arguments.count < 1 or arguments.count > 10_000:
        raise SystemExit("--count must be between 1 and 10000")

    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.connect(arguments.socket)
        for event in fake_events(arguments.session_id, arguments.count):
            send_frame(connection, event)

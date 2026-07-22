import asyncio
import os
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

from .secure_output import open_owner_only

_PCAPNG_SECTION_HEADER = 0x0A0D0D0A
_PCAPNG_INTERFACE_DESCRIPTION = 0x00000001
_DEFAULT_SNAPLEN = 262_144


def normalize_pcapng_snaplen(path: Path, snaplen: int = _DEFAULT_SNAPLEN) -> int:
    """Set an explicit IDB snaplen for libpcap compatibility.

    python-pcapng emits the spec-valid value zero (unlimited), while the macOS
    libpcap bundled with tcpdump rejects otherwise valid enhanced packets in
    such a section. Writing a bounded explicit value makes the evidence portable.
    """
    if not 65_535 <= snaplen <= 16 * 1024 * 1024:
        raise ValueError("snaplen must be between 65535 and 16777216")
    updated = 0
    descriptor = os.open(path, os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "r+b") as stream:
        file_size = os.fstat(stream.fileno()).st_size
        header = stream.read(12)
        if len(header) != 12 or int.from_bytes(header[:4], "little") != _PCAPNG_SECTION_HEADER:
            raise ValueError("capture is not a PCAPNG section")
        byte_order_magic = header[8:12]
        if byte_order_magic == b"\x4d\x3c\x2b\x1a":
            byteorder = "little"
        elif byte_order_magic == b"\x1a\x2b\x3c\x4d":
            byteorder = "big"
        else:
            raise ValueError("invalid PCAPNG byte-order magic")
        stream.seek(0)
        while True:
            block_start = stream.tell()
            block_header = stream.read(8)
            if not block_header:
                break
            if len(block_header) != 8:
                stream.truncate(block_start)
                break
            block_type = int.from_bytes(block_header[:4], byteorder)
            block_length = int.from_bytes(block_header[4:], byteorder)
            if block_length < 12 or block_length % 4:
                raise ValueError("invalid PCAPNG block length")
            if block_start + block_length > file_size:
                stream.truncate(block_start)
                break
            if block_type == _PCAPNG_INTERFACE_DESCRIPTION:
                body = stream.read(8)
                if len(body) != 8:
                    raise ValueError("truncated PCAPNG interface block")
                if int.from_bytes(body[4:8], byteorder) == 0:
                    stream.seek(block_start + 12)
                    stream.write(snaplen.to_bytes(4, byteorder))
                    updated += 1
            stream.seek(block_start + block_length - 4)
            trailer = stream.read(4)
            if len(trailer) != 4 or int.from_bytes(trailer, byteorder) != block_length:
                raise ValueError("invalid PCAPNG trailing block length")
            stream.seek(block_start + block_length)
        stream.flush()
        os.fsync(stream.fileno())
    return updated


async def iter_packet_records(
    service: Any,
    count: int = -1,
    parse_packet: Callable[[bytes], Any] | None = None,
) -> AsyncIterator[Any]:
    from pymobiledevice3.services.pcapd import (
        ETHERNET_HEADER,
        INTERFACE_NAMES,
        CrossPlatformAddressFamily,
        device_packet_struct,
    )

    parse = parse_packet or device_packet_struct.parse
    emitted = 0
    while emitted != count:
        record = await service.recv_plist()
        if not record:
            break
        if isinstance(record, dict):
            # Newer pcapd versions begin with a capabilities handshake.
            continue
        packet = parse(record)
        if hasattr(packet, "interface_type"):
            packet.interface_type = INTERFACE_NAMES(packet.interface_type)
        if hasattr(packet, "protocol_family"):
            packet.protocol_family = CrossPlatformAddressFamily(packet.protocol_family)
        if hasattr(packet, "frame_pre_length") and not packet.frame_pre_length:
            packet.data = ETHERNET_HEADER + packet.data
        elif getattr(packet, "interface_name", None) == "pdp_ip":
            packet.data = ETHERNET_HEADER + packet.data[4:]
        yield packet
        emitted += 1


async def capture_pcap(
    output: Path, udid: str | None = None, count: int = -1
) -> dict[str, Any]:
    from pymobiledevice3.lockdown import create_using_usbmux
    from pymobiledevice3.services.pcapd import PcapdService

    lockdown = await create_using_usbmux(
        serial=udid, connection_type="USB", autopair=False
    )
    service = PcapdService(lockdown)
    output.parent.mkdir(parents=True, exist_ok=True)
    packet_count = 0

    async def counted_packets():
        nonlocal packet_count
        async for packet in iter_packet_records(service.service, count=count):
            packet_count += 1
            yield packet

    cancelled = False
    try:
        with open_owner_only(output, "wb") as stream:
            try:
                await service.write_to_pcap(
                    stream,
                    counted_packets(),
                )
            except asyncio.CancelledError:
                cancelled = True
            finally:
                stream.flush()
                os.fsync(stream.fileno())
        normalize_pcapng_snaplen(output)
        if cancelled:
            raise asyncio.CancelledError
        return {
            "path": str(output),
            "packet_count": packet_count,
            "size_bytes": output.stat().st_size,
        }
    finally:
        await service.service.close()
        await lockdown.close()

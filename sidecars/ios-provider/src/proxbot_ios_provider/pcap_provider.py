import asyncio
import hashlib
import ipaddress
import os
import struct
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

from .secure_output import open_owner_only

_PCAPNG_SECTION_HEADER = 0x0A0D0D0A
_PCAPNG_INTERFACE_DESCRIPTION = 0x00000001
_DEFAULT_SNAPLEN = 262_144


def _ethernet_header_for(payload: bytes, template: bytes) -> bytes:
    """Return a synthetic Ethernet header with the payload's real IP type."""
    ip_version = payload[0] >> 4 if payload else 0
    ether_type = b"\x86\xdd" if ip_version == 6 else b"\x08\x00"
    return template[:12] + ether_type


def packet_metadata(packet: Any, frame: bytes | None = None) -> dict[str, Any]:
    """Extract bounded L3/L4 metadata without claiming HTTP/TLS plaintext."""
    data = frame if frame is not None else bytes(packet.data)
    raw_pid = int(getattr(packet, "pid", 0))
    raw_direction = getattr(packet, "io", None)
    # Apple pcapd uses 1 for output. Depending on the capture service version,
    # input is observed as 0 or 2; only other/missing values remain unknown.
    direction = {0: "inbound", 1: "outbound", 2: "inbound"}.get(
        raw_direction, "unknown"
    )
    result: dict[str, Any] = {
        "direction": direction,
        "interface": str(getattr(packet, "interface_name", "")),
        # pcapd uses UINT32_MAX when no originating process is available.
        "process_id": None if raw_pid in {0, 0xFFFFFFFF} else raw_pid,
        "process_name": str(getattr(packet, "comm", "") or getattr(packet, "ecomm", "")) or None,
        "packet_bytes": len(data),
        "protocol": "ETHERNET",
    }
    if len(data) < 14:
        return result
    offset = 14
    ether_type = int.from_bytes(data[12:14], "big")
    while ether_type in {0x8100, 0x88A8} and len(data) >= offset + 4:
        ether_type = int.from_bytes(data[offset + 2 : offset + 4], "big")
        offset += 4
    transport_offset: int | None = None
    transport_end = len(data)
    protocol_number: int | None = None
    if ether_type == 0x0800 and len(data) >= offset + 20 and data[offset] >> 4 == 4:
        header_length = (data[offset] & 0x0F) * 4
        total_length = int.from_bytes(data[offset + 2 : offset + 4], "big")
        if (
            header_length >= 20
            and total_length >= header_length
            and len(data) >= offset + header_length
        ):
            transport_end = min(len(data), offset + total_length)
            result["source_ip"] = str(ipaddress.ip_address(data[offset + 12 : offset + 16]))
            result["destination_ip"] = str(ipaddress.ip_address(data[offset + 16 : offset + 20]))
            protocol_number = data[offset + 9]
            transport_offset = offset + header_length
            result["ip_version"] = 4
            fragment_bits = int.from_bytes(data[offset + 6 : offset + 8], "big")
            if fragment_bits & 0x1FFF:
                # Only the first IPv4 fragment begins with the transport header.
                transport_offset = None
    elif ether_type == 0x86DD and len(data) >= offset + 40 and data[offset] >> 4 == 6:
        result["source_ip"] = str(ipaddress.ip_address(data[offset + 8 : offset + 24]))
        result["destination_ip"] = str(ipaddress.ip_address(data[offset + 24 : offset + 40]))
        protocol_number = data[offset + 6]
        payload_length = int.from_bytes(data[offset + 4 : offset + 6], "big")
        transport_end = min(len(data), offset + 40 + payload_length)
        transport_offset = offset + 40 if payload_length else None
        result["ip_version"] = 6
        # Walk the bounded, length-prefixed IPv6 extension-header chain so TCP
        # and UDP endpoints remain visible for modern iOS traffic.
        extension_count = 0
        while protocol_number in {0, 43, 44, 51, 60} and transport_offset is not None:
            extension_count += 1
            if extension_count > 16:
                transport_offset = None
                break
            if transport_end < transport_offset + 2:
                transport_offset = None
                break
            next_header = data[transport_offset]
            if protocol_number == 44:  # Fragment header: fixed eight bytes.
                extension_length = 8
                if transport_end < transport_offset + 4:
                    transport_offset = None
                    break
                fragment_bits = int.from_bytes(
                    data[transport_offset + 2 : transport_offset + 4], "big"
                )
                if (fragment_bits >> 3) & 0x1FFF:
                    transport_offset = None
                    protocol_number = next_header
                    break
            elif protocol_number == 51:  # Authentication Header, RFC 4302.
                extension_length = (data[transport_offset + 1] + 2) * 4
            else:
                extension_length = (data[transport_offset + 1] + 1) * 8
            if extension_length <= 0 or transport_end < transport_offset + extension_length:
                transport_offset = None
                break
            transport_offset += extension_length
            protocol_number = next_header
    names = {1: "ICMP", 6: "TCP", 17: "UDP", 58: "ICMPV6"}
    if protocol_number is not None:
        result["protocol"] = names.get(protocol_number, f"IP/{protocol_number}")
    if protocol_number in {6, 17} and transport_offset is not None and transport_end >= transport_offset + 4:
        result["source_port"], result["destination_port"] = struct.unpack_from("!HH", data, transport_offset)
    return result


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
            packet.data = _ethernet_header_for(packet.data, ETHERNET_HEADER) + packet.data
        elif getattr(packet, "interface_name", None) == "pdp_ip":
            payload = packet.data[4:]
            packet.data = _ethernet_header_for(payload, ETHERNET_HEADER) + payload
        yield packet
        emitted += 1


async def capture_pcap(
    output: Path,
    udid: str | None = None,
    count: int = -1,
    on_packet: Callable[
        [Any, dict[str, Any], dict[str, Any], bytes], Any
    ]
    | None = None,
    *,
    artifact_relative_path: str = "capture/device.pcapng",
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
            # Freeze the pcapd buffer exactly once. The same immutable bytes are
            # parsed, hashed and enriched after the PCAPNG writer has committed
            # the block, avoiding independent full-frame copies on the hot path.
            packet_data = bytes(packet.data) if on_packet is not None else None
            metadata = (
                packet_metadata(packet, packet_data)
                if packet_data is not None
                else None
            )
            block_start = stream.tell()
            # Hand the packet to the PCAPNG writer first. When the generator is
            # resumed, the complete block has already been written, so slower
            # metadata indexing never precedes the primary packet evidence.
            yield packet
            if on_packet is not None:
                # PCAPNG Enhanced Packet Blocks have a fixed 28-byte prefix
                # before packet_data (type/length/interface/timestamp/captured
                # and original lengths). Flush the userspace buffer before
                # publishing the reference so a concurrent reader can resolve
                # the exact evidence range immediately. Per-packet fsync would
                # unnecessarily stall capture; finalization performs the
                # durable sync below.
                stream.flush()
                assert packet_data is not None
                raw_ref = {
                    "relative_path": artifact_relative_path,
                    "offset": block_start + 28,
                    "length": len(packet_data),
                    "sha256": hashlib.sha256(packet_data).hexdigest(),
                }
                callback_result = on_packet(
                    packet, metadata or {}, raw_ref, packet_data
                )
                if asyncio.iscoroutine(callback_result):
                    await callback_result

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

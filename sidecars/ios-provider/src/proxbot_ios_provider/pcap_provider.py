from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

from .secure_output import open_owner_only


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
    try:
        with open_owner_only(output, "wb") as stream:
            await service.write_to_pcap(
                stream,
                iter_packet_records(service.service, count=count),
            )
        return {
            "path": str(output),
            "packet_count": count,
            "size_bytes": output.stat().st_size,
        }
    finally:
        await service.service.close()
        await lockdown.close()

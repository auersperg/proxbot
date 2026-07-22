from collections.abc import Iterable
from typing import Any


def normalize_usb_devices(devices: Iterable[Any]) -> list[dict[str, Any]]:
    return [
        {
            "id": device.serial,
            "connection_type": "usb",
            "device_number": device.devid,
        }
        for device in devices
        if str(device.connection_type).lower() == "usb"
    ]


async def device_preflight(udid: str | None = None) -> dict[str, Any]:
    from pymobiledevice3.lockdown import create_using_usbmux
    from pymobiledevice3.usbmux import list_devices

    usb_devices = normalize_usb_devices(await list_devices())
    if udid is not None:
        usb_devices = [device for device in usb_devices if device["id"] == udid]
    if not usb_devices:
        return {"available": False, "error": "no matching USB iPhone"}

    selected = usb_devices[0]
    lockdown = await create_using_usbmux(
        serial=selected["id"], connection_type="USB", autopair=False
    )
    try:
        values = lockdown.all_values
        return {
            "available": True,
            "id": selected["id"],
            "connection_type": "usb",
            "paired": bool(lockdown.paired),
            "trusted": bool(values.get("TrustedHostAttached", False)),
            "device_name": values.get("DeviceName"),
            "device_class": values.get("DeviceClass"),
            "product_type": values.get("ProductType"),
            "product_version": values.get("ProductVersion"),
            "build_version": values.get("BuildVersion"),
            "developer_mode": values.get("DeveloperModeStatus"),
        }
    finally:
        await lockdown.close()

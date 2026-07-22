import asyncio
from types import SimpleNamespace

from proxbot_ios_provider.device_provider import normalize_usb_devices


def test_device_inventory_keeps_usb_and_redacts_no_fields_in_raw_provider_result():
    devices = [
        SimpleNamespace(serial="USB-UDID", connection_type="USB", devid=7),
        SimpleNamespace(serial="USB-UDID", connection_type="Network", devid=9),
    ]

    assert normalize_usb_devices(devices) == [
        {"id": "USB-UDID", "connection_type": "usb", "device_number": 7}
    ]

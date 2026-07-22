from typing import Any


def usb_preflight(frida_module: Any) -> dict[str, Any]:
    try:
        device = frida_module.get_usb_device(timeout=5)
    except Exception as error:
        return {"available": False, "error": str(error)}
    return {
        "available": True,
        "id": device.id,
        "name": device.name,
        "type": device.type,
    }

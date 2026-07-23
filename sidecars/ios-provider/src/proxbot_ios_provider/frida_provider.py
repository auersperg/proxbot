import queue
import threading
from typing import Any

from . import __version__


def _discover_ios_device(frida_module: Any, device_id: str | None = None) -> Any:
    if device_id is not None:
        return frida_module.get_device(device_id, timeout=5)
    usb_error: Exception | None = None
    try:
        return frida_module.get_usb_device(timeout=5)
    except Exception as error:
        usb_error = error
    if hasattr(frida_module, "enumerate_devices"):
        candidates = [
            device
            for device in frida_module.enumerate_devices()
            if getattr(device, "type", None) == "usb"
            or (
                getattr(device, "type", None) == "remote"
                and str(getattr(device, "name", "")).startswith("iOS Device")
            )
        ]
        if candidates:
            return sorted(candidates, key=lambda device: str(device.id))[0]
    assert usb_error is not None
    raise usb_error


def runtime_probe(frida_module: Any) -> dict[str, Any]:
    """Describe the bundled host runtime without claiming target attach access."""

    return {
        "available": True,
        "provider": "ios-live",
        "provider_version": __version__,
        "frida_version": str(frida_module.__version__),
        "schema_version": 1,
        "capabilities": [
            "usb_device_discovery",
            "paired_ios_device_discovery",
            "jailbroken_frida_server_attach",
            "jailed_debuggable_app_attach",
        ],
        "application_plaintext": False,
        "generic_app_store_process_injection": False,
        "target_requirements": {
            "jailbroken": ["matching frida-server reachable over USB"],
            "jailed": [
                "Developer Mode enabled",
                "Developer Disk Image mounted",
                "target signed as debuggable with get-task-allow",
                "matching Frida Gadget available",
            ],
        },
    }


def usb_preflight(frida_module: Any, device_id: str | None = None) -> dict[str, Any]:
    result = runtime_probe(frida_module)
    try:
        device = _discover_ios_device(frida_module, device_id)
    except Exception as error:
        result.update(
            {
                "available": False,
                "host_runtime_available": True,
                "error": str(error),
            }
        )
        return result
    result.update(
        {
            "available": True,
            "host_runtime_available": True,
            "id": device.id,
            "name": device.name,
            "type": device.type,
        }
    )
    return result


def target_preflight(
    frida_module: Any,
    bundle_id: str,
    device_id: str | None = None,
) -> dict[str, Any]:
    """Test target attachability and detach immediately; do not spawn or hook it."""

    result = runtime_probe(frida_module)
    result.update(
        {
            "bundle_id": bundle_id,
            "target_found": False,
            "target_running": False,
            "attachable": False,
            "start_ready": False,
        }
    )
    try:
        device = _discover_ios_device(frida_module, device_id)
    except Exception as error:
        result.update(
            {
                "available": False,
                "host_runtime_available": True,
                "blocker": "ios_device_unavailable",
                "error": str(error),
            }
        )
        return result

    result.update(
        {
            "device_id": str(device.id),
            "device_name": str(device.name),
            "device_type": str(device.type),
        }
    )
    try:
        application = next(
            (
                candidate
                for candidate in device.enumerate_applications()
                if str(candidate.identifier) == bundle_id
            ),
            None,
        )
    except Exception as error:
        result.update(
            {
                "blocker": "application_enumeration_failed",
                "error": str(error),
            }
        )
        return result
    if application is None:
        result.update(
            {
                "blocker": "target_not_installed",
                "error": f"application {bundle_id} was not found",
            }
        )
        return result

    process_id = int(getattr(application, "pid", 0) or 0)
    result.update(
        {
            "target_found": True,
            "target_name": str(application.name),
            "target_running": process_id > 0,
            "process_id": process_id or None,
        }
    )
    if process_id <= 0:
        result.update(
            {
                "blocker": "target_not_running",
                "error": "target must already be running; preflight does not spawn applications",
            }
        )
        return result

    outcome: queue.Queue[tuple[str, Any]] = queue.Queue(maxsize=1)

    def attach_and_detach() -> None:
        try:
            session = device.attach(process_id)
            session.detach()
            outcome.put_nowait(("attached", None))
        except Exception as error:
            outcome.put_nowait(("error", error))

    worker = threading.Thread(
        target=attach_and_detach,
        name="proxbot-frida-attach-preflight",
        daemon=True,
    )
    worker.start()
    worker.join(timeout=10.0)
    if worker.is_alive():
        result.update(
            {
                "blocker": "target_attach_timeout",
                "error": "Frida attach did not complete within 10 seconds",
            }
        )
        return result
    status, detail = outcome.get_nowait()
    if status == "error":
        result.update(
            {
                "blocker": "target_attach_unavailable",
                "error": str(detail),
            }
        )
        return result
    result.update(
        {
            "attachable": True,
            "start_ready": True,
            "blocker": None,
            # Attaching alone does not prove that any application bytes
            # were captured. A future start command must flip this only
            # after an observed hook event.
            "application_plaintext": False,
        }
    )
    return result

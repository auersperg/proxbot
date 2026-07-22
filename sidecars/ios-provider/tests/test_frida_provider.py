from types import SimpleNamespace

from proxbot_ios_provider.frida_provider import usb_preflight


class FakeFrida:
    @staticmethod
    def get_usb_device(timeout):
        assert timeout == 5
        return SimpleNamespace(id="fixture-usb", name="Fixture iPhone", type="usb")


class MissingFrida:
    @staticmethod
    def get_usb_device(timeout):
        raise RuntimeError(f"no USB device after {timeout} seconds")


def test_usb_preflight_returns_serializable_device_metadata():
    assert usb_preflight(FakeFrida) == {
        "available": True,
        "id": "fixture-usb",
        "name": "Fixture iPhone",
        "type": "usb",
    }


def test_usb_preflight_returns_structured_error():
    assert usb_preflight(MissingFrida) == {
        "available": False,
        "error": "no USB device after 5 seconds",
    }

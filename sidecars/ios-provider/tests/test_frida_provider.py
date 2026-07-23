from types import SimpleNamespace

from proxbot_ios_provider.frida_provider import (
    runtime_probe,
    target_preflight,
    usb_preflight,
)


class FakeFrida:
    __version__ = "17.16.4"

    @staticmethod
    def get_usb_device(timeout):
        assert timeout == 5
        return SimpleNamespace(id="fixture-usb", name="Fixture iPhone", type="usb")


class MissingFrida:
    __version__ = "17.16.4"

    @staticmethod
    def get_usb_device(timeout):
        raise RuntimeError(f"no USB device after {timeout} seconds")


def test_usb_preflight_returns_serializable_device_metadata():
    result = usb_preflight(FakeFrida)
    assert result["available"] is True
    assert result["host_runtime_available"] is True
    assert result["frida_version"] == "17.16.4"
    assert result["id"] == "fixture-usb"
    assert result["name"] == "Fixture iPhone"
    assert result["type"] == "usb"
    assert result["application_plaintext"] is False


def test_usb_preflight_returns_structured_error():
    result = usb_preflight(MissingFrida)
    assert result["available"] is False
    assert result["host_runtime_available"] is True
    assert result["error"] == "no USB device after 5 seconds"
    assert result["generic_app_store_process_injection"] is False


def test_runtime_probe_is_honest_about_stock_ios_plaintext_requirements():
    result = runtime_probe(FakeFrida)
    assert result["available"] is True
    assert result["provider"] == "ios-live"
    assert result["frida_version"] == "17.16.4"
    assert result["application_plaintext"] is False
    assert result["generic_app_store_process_injection"] is False
    assert "target signed as debuggable with get-task-allow" in result["target_requirements"]["jailed"]


class NetworkFrida(MissingFrida):
    device = SimpleNamespace(
        id="fixture-network",
        name="iOS Device [fe80::1]",
        type="remote",
    )

    @classmethod
    def enumerate_devices(cls):
        return [
            SimpleNamespace(id="local", name="Local System", type="local"),
            cls.device,
        ]


def test_preflight_falls_back_to_paired_ios_device():
    result = usb_preflight(NetworkFrida)
    assert result["available"] is True
    assert result["id"] == "fixture-network"
    assert result["type"] == "remote"


class TargetFrida(NetworkFrida):
    detached = False

    class Session:
        @staticmethod
        def detach():
            TargetFrida.detached = True

    @classmethod
    def attach(cls, process_id):
        assert process_id == 42
        return cls.Session()


TargetFrida.device = SimpleNamespace(
    id="fixture-network",
    name="iOS Device [fe80::1]",
    type="remote",
    enumerate_applications=lambda: [
        SimpleNamespace(identifier="x.place", name="XPlace", pid=42)
    ],
    attach=TargetFrida.attach,
)


def test_target_preflight_attaches_and_detaches_without_claiming_plaintext():
    TargetFrida.detached = False
    result = target_preflight(TargetFrida, "x.place")
    assert result["target_found"] is True
    assert result["target_running"] is True
    assert result["attachable"] is True
    assert result["start_ready"] is True
    assert result["application_plaintext"] is False
    assert TargetFrida.detached is True


class BlockedTargetFrida(NetworkFrida):
    @staticmethod
    def attach(_process_id):
        raise RuntimeError("unable to attach to the specified process")


BlockedTargetFrida.device = SimpleNamespace(
    id="fixture-network",
    name="iOS Device [fe80::1]",
    type="remote",
    enumerate_applications=lambda: [
        SimpleNamespace(identifier="x.place", name="XPlace", pid=42)
    ],
    attach=BlockedTargetFrida.attach,
)


def test_target_preflight_reports_stock_target_attach_blocker():
    result = target_preflight(BlockedTargetFrida, "x.place")
    assert result["target_found"] is True
    assert result["attachable"] is False
    assert result["start_ready"] is False
    assert result["blocker"] == "target_attach_unavailable"
    assert result["error"] == "unable to attach to the specified process"

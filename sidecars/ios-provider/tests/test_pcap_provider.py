import asyncio
import hashlib
import struct
from types import SimpleNamespace

from proxbot_ios_provider.pcap_provider import (
    capture_pcap,
    iter_packet_records,
    normalize_pcapng_snaplen,
    packet_metadata,
)


def test_packet_metadata_extracts_ipv4_tcp_direction_process_and_remote_endpoint():
    ethernet = bytes.fromhex("00112233445566778899aabb0800")
    ipv4 = bytes.fromhex("4500002800000000400600000a00000108080808")
    tcp = struct.pack("!HH", 49152, 443) + bytes(16)
    packet = SimpleNamespace(
        data=ethernet + ipv4 + tcp,
        io=1,
        interface_name="en0",
        pid=42,
        comm="WalletApp",
        ecomm="",
    )

    metadata = packet_metadata(packet)

    assert metadata == {
        "direction": "outbound",
        "interface": "en0",
        "process_id": 42,
        "process_name": "WalletApp",
        "packet_bytes": 54,
        "protocol": "TCP",
        "source_ip": "10.0.0.1",
        "destination_ip": "8.8.8.8",
        "ip_version": 4,
        "source_port": 49152,
        "destination_port": 443,
    }


def test_packet_metadata_walks_ipv6_extensions_and_normalizes_unknown_pid():
    ethernet = bytes.fromhex("00112233445566778899aabb86dd")
    # IPv6 next-header 0 (hop-by-hop), then an eight-byte extension pointing
    # at UDP, followed by the UDP endpoints.
    ipv6 = (
        bytes.fromhex("6000000000100040")
        + bytes.fromhex("fe800000000000000000000000000001")
        + bytes.fromhex("ff0200000000000000000000000000fb")
    )
    hop_by_hop = bytes([17, 0]) + bytes(6)
    udp = struct.pack("!HHHH", 5353, 5353, 8, 0)
    packet = SimpleNamespace(
        data=ethernet + ipv6 + hop_by_hop + udp,
        io=2,
        interface_name="en0",
        pid=0xFFFFFFFF,
        comm="",
        ecomm="",
    )

    metadata = packet_metadata(packet)

    assert metadata["direction"] == "inbound"
    assert metadata["process_id"] is None
    assert metadata["protocol"] == "UDP"
    assert metadata["source_port"] == 5353
    assert metadata["destination_port"] == 5353
    assert metadata["source_ip"] == "fe80::1"
    assert metadata["destination_ip"] == "ff02::fb"


def test_packet_metadata_does_not_invent_ports_for_non_initial_ipv4_fragment():
    ethernet = bytes.fromhex("00112233445566778899aabb0800")
    # Fragment offset one (eight bytes): the following bytes are payload, not a
    # transport header, even though the IPv4 protocol field says UDP.
    ipv4 = bytes.fromhex("4500001c00000001401100000a00000108080808")
    packet = SimpleNamespace(
        data=ethernet + ipv4 + struct.pack("!HH", 1234, 443),
        io=1,
        interface_name="en0",
        pid=0,
        comm="",
        ecomm="",
    )

    metadata = packet_metadata(packet)

    assert metadata["protocol"] == "UDP"
    assert "source_port" not in metadata
    assert "destination_port" not in metadata


class FakeService:
    def __init__(self):
        self.records = [
            {"capabilities": ["droptap"]},
            b"packet-one",
            b"packet-two",
        ]

    async def recv_plist(self):
        return self.records.pop(0)


def test_packet_iterator_skips_capability_handshake_and_honors_count():
    async def collect():
        return [
            packet
            async for packet in iter_packet_records(
                FakeService(),
                count=1,
                parse_packet=lambda value: SimpleNamespace(data=value),
            )
        ]

    packets = asyncio.run(collect())
    assert [packet.data for packet in packets] == [b"packet-one"]


def test_packet_iterator_synthesizes_ipv6_ether_type_for_raw_ip_payload():
    class RawIpv6Service:
        def __init__(self):
            self.records = [bytes.fromhex("6000000000003a40") + bytes(32)]

        async def recv_plist(self):
            return self.records.pop(0)

    async def collect():
        return [
            packet
            async for packet in iter_packet_records(
                RawIpv6Service(),
                count=1,
                parse_packet=lambda value: SimpleNamespace(
                    data=value,
                    frame_pre_length=0,
                ),
            )
        ]

    packet = asyncio.run(collect())[0]
    assert packet.data[12:14] == b"\x86\xdd"
    assert packet.data[14] >> 4 == 6


def test_zero_snaplen_is_normalized_for_libpcap_compatibility(tmp_path):
    capture = tmp_path / "capture.pcapng"
    section = struct.pack("<IIIHHqI", 0x0A0D0D0A, 28, 0x1A2B3C4D, 1, 0, -1, 28)
    interface = struct.pack("<IIHHII", 1, 20, 1, 0, 0, 20)
    capture.write_bytes(section + interface)

    assert normalize_pcapng_snaplen(capture) == 1
    assert int.from_bytes(capture.read_bytes()[40:44], "little") == 262_144


def test_normalizer_rejects_non_pcapng_input(tmp_path):
    capture = tmp_path / "capture.pcapng"
    capture.write_bytes(b"not-pcapng")
    try:
        normalize_pcapng_snaplen(capture)
    except ValueError as error:
        assert "not a PCAPNG" in str(error)
    else:
        raise AssertionError("non-PCAPNG input was accepted")


def test_capture_callback_receives_exact_packet_range_in_pcapng(
    tmp_path, monkeypatch
):
    import pymobiledevice3.lockdown as lockdown_module
    import pymobiledevice3.services.pcapd as pcapd_module
    from proxbot_ios_provider import pcap_provider

    packet_data = (
        bytes.fromhex("00112233445566778899aabb0800")
        + bytes.fromhex("4500002800000000400600000a00000108080808")
        + struct.pack("!HH", 49152, 443)
        + bytes(16)
    )
    packet = SimpleNamespace(
        data=packet_data,
        timestamp=1_784_730_000.125,
        pid=42,
        comm="FixtureApp",
        epid=0,
        ecomm="",
        svc=0,
        io=1,
        interface_name="en0",
    )

    class FakeLockdown:
        product_version = "27.0"

        async def close(self):
            return None

    class FakeReceiver:
        async def close(self):
            return None

    real_write_to_pcap = pcapd_module.PcapdService.write_to_pcap

    class FakePcapdService:
        write_to_pcap = real_write_to_pcap

        def __init__(self, lockdown):
            self.lockdown = lockdown
            self.service = FakeReceiver()

    async def fake_create_using_usbmux(**_kwargs):
        return FakeLockdown()

    async def fake_iter_packet_records(_service, count=-1, parse_packet=None):
        del count, parse_packet
        yield packet

    monkeypatch.setattr(
        lockdown_module, "create_using_usbmux", fake_create_using_usbmux
    )
    monkeypatch.setattr(pcapd_module, "PcapdService", FakePcapdService)
    monkeypatch.setattr(
        pcap_provider, "iter_packet_records", fake_iter_packet_records
    )
    observed = []

    async def on_packet(_packet, metadata, raw_ref):
        observed.append((metadata, raw_ref))

    capture = tmp_path / "device.pcapng"
    result = asyncio.run(
        capture_pcap(
            capture,
            "fixture-udid",
            1,
            on_packet,
            artifact_relative_path="capture/device.pcapng",
        )
    )

    assert result["packet_count"] == 1
    assert len(observed) == 1
    metadata, raw_ref = observed[0]
    assert metadata["destination_ip"] == "8.8.8.8"
    assert raw_ref == {
        "relative_path": "capture/device.pcapng",
        "offset": raw_ref["offset"],
        "length": len(packet_data),
        "sha256": hashlib.sha256(packet_data).hexdigest(),
    }
    assert capture.read_bytes()[
        raw_ref["offset"] : raw_ref["offset"] + raw_ref["length"]
    ] == packet_data

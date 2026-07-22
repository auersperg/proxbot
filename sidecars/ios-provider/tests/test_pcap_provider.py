import asyncio
import struct
from types import SimpleNamespace

from proxbot_ios_provider.pcap_provider import (
    iter_packet_records,
    normalize_pcapng_snaplen,
)


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

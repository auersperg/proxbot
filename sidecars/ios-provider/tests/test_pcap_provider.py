import asyncio
from types import SimpleNamespace

from proxbot_ios_provider.pcap_provider import iter_packet_records


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

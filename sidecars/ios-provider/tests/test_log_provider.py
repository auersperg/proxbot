import asyncio

from proxbot_ios_provider.log_provider import iter_log_records


async def fixture_lines():
    yield "first raw line"
    yield "second raw line"


def test_log_records_preserve_original_lines_and_sequence():
    async def collect():
        clock = iter([100, 101])
        return [
            record
            async for record in iter_log_records(
                fixture_lines(), count=2, clock_ns=clock.__next__
            )
        ]

    assert asyncio.run(collect()) == [
        {"sequence": 0, "host_time_ns": 100, "raw": "first raw line"},
        {"sequence": 1, "host_time_ns": 101, "raw": "second raw line"},
    ]

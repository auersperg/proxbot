import asyncio

from proxbot_ios_provider.log_provider import iter_log_records


async def fixture_lines():
    yield "first raw line"
    yield "second raw line"


def test_log_records_preserve_original_lines_and_sequence():
    async def collect():
        return [record async for record in iter_log_records(fixture_lines(), count=2)]

    assert asyncio.run(collect()) == [
        {"sequence": 0, "raw": "first raw line"},
        {"sequence": 1, "raw": "second raw line"},
    ]

from collections.abc import Iterator
from typing import Any


def fake_events(session_id: str, count: int) -> Iterator[dict[str, Any]]:
    kinds = ("provider.ready", "network.request", "network.response")
    for sequence in range(count):
        yield {
            "schema_version": 1,
            "provider_id": "fake",
            "provider_version": "0.1.0",
            "session_id": session_id,
            "sequence": sequence,
            "source_time_ns": 1_000_000 + sequence,
            "host_time_ns": 2_000_000 + sequence,
            "monotonic_time_ns": 500_000 + sequence,
            "device_id": "fixture-device",
            "process_id": 42,
            "process_name": "FixtureApp",
            "evidence": "observed",
            "kind": kinds[sequence % len(kinds)],
            "payload": {
                "fixture": True,
                "sequence": sequence,
                "endpoint": "https://fixture.invalid/v1/capture",
            },
            "raw_ref": None,
            "parse_status": "parsed",
        }

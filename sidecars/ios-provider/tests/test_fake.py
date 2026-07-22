from tracelab_ios_provider.fake import fake_events


def test_fake_events_are_deterministic_and_contiguous():
    events = list(fake_events("00000000-0000-0000-0000-000000000000", 3))
    assert [event["sequence"] for event in events] == [0, 1, 2]
    assert [event["kind"] for event in events] == [
        "provider.ready",
        "network.request",
        "network.response",
    ]
    assert all(event["evidence"] == "observed" for event in events)

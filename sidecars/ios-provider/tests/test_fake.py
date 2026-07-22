from proxbot_ios_provider.fake import fake_events


def test_fake_events_are_deterministic_and_contiguous():
    events = list(fake_events("00000000-0000-0000-0000-000000000000", 3))
    assert [event["sequence"] for event in events] == [0, 1, 2]
    assert [event["kind"] for event in events] == [
        "provider.ready",
        "network.request",
        "network.response",
    ]
    assert all(event["evidence"] == "observed" for event in events)


def test_fake_http_exchange_preserves_pairing_and_raw_evidence():
    events = list(fake_events("00000000-0000-0000-0000-000000000000", 3))
    request, response = events[1:]

    assert request["payload"]["request_id"] == "request-000001"
    assert response["payload"]["request_id"] == request["payload"]["request_id"]
    assert request["payload"]["method"] == "POST"
    assert request["payload"]["host"] == "auth.privy.io"
    assert request["payload"]["ip"] == "192.0.2.10"
    assert request["payload"]["protocol"] == "HTTP/2"
    assert request["payload"]["raw"].startswith("POST /api/v1/wallets/rpc HTTP/2\r\n")
    assert response["payload"]["status"] == 200
    assert response["payload"]["raw"].startswith("HTTP/2 200 OK\r\n")
    assert request["payload"]["request_bytes"] > 0
    assert response["payload"]["response_bytes"] > 0
    assert request["payload"]["tls"] == "decrypted"

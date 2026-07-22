from collections.abc import Iterator
from typing import Any

_EXCHANGES = (
    {
        "host": "auth.privy.io",
        "ip": "192.0.2.10",
        "method": "POST",
        "path": "/api/v1/wallets/rpc",
        "status": 200,
        "reason": "OK",
        "protocol": "HTTP/2",
        "request_body": '{"method":"signTransaction"}',
        "response_body": '{"method":"signTransaction","status":"signed"}',
    },
    {
        "host": "api.mainnet-beta.solana.com",
        "ip": "198.51.100.20",
        "method": "POST",
        "path": "/",
        "status": 200,
        "reason": "OK",
        "protocol": "HTTP/2",
        "request_body": '{"jsonrpc":"2.0","method":"sendTransaction","id":1}',
        "response_body": '{"jsonrpc":"2.0","result":"5QnightVisionFixture"}',
    },
    {
        "host": "api.eu.amplitude.com",
        "ip": "203.0.113.30",
        "method": "POST",
        "path": "/2/httpapi",
        "status": 202,
        "reason": "Accepted",
        "protocol": "HTTP/1.1",
        "request_body": '{"events":[{"event_type":"wallet_signed"}]}',
        "response_body": '{"code":200,"events_ingested":1}',
    },
    {
        "host": "gateway.icloud.com",
        "ip": "192.0.2.40",
        "method": "CONNECT",
        "path": ":443",
        "status": 200,
        "reason": "Connection Established",
        "protocol": "HTTP/1.1",
        "request_body": "",
        "response_body": "",
    },
)


def _raw_request(exchange: dict[str, Any]) -> str:
    body = exchange["request_body"]
    return (
        f'{exchange["method"]} {exchange["path"]} {exchange["protocol"]}\r\n'
        f'Host: {exchange["host"]}\r\n'
        "Accept: application/json\r\n"
        "Content-Type: application/json\r\n"
        f"Content-Length: {len(body.encode())}\r\n"
        "\r\n"
        f"{body}"
    )


def _raw_response(exchange: dict[str, Any]) -> str:
    body = exchange["response_body"]
    return (
        f'{exchange["protocol"]} {exchange["status"]} {exchange["reason"]}\r\n'
        "Content-Type: application/json\r\n"
        f"Content-Length: {len(body.encode())}\r\n"
        "Strict-Transport-Security: max-age=31536000\r\n"
        "\r\n"
        f"{body}"
    )


def fake_events(session_id: str, count: int) -> Iterator[dict[str, Any]]:
    for sequence in range(count):
        if sequence == 0:
            kind = "provider.ready"
            payload: dict[str, Any] = {
                "fixture": True,
                "provider": "fake",
                "capabilities": ["http", "tls", "raw"],
            }
        else:
            exchange_index = (sequence - 1) // 2
            exchange = _EXCHANGES[exchange_index % len(_EXCHANGES)]
            request_id = f"request-{exchange_index * 2 + 1:06d}"
            if sequence % 2 == 1:
                kind = "network.request"
                raw = _raw_request(exchange)
                payload = {
                    "fixture": True,
                    "request_id": request_id,
                    "scheme": "https",
                    "host": exchange["host"],
                    "ip": exchange["ip"],
                    "method": exchange["method"],
                    "path": exchange["path"],
                    "protocol": exchange["protocol"],
                    "tls": "decrypted",
                    "request_bytes": len(raw.encode()),
                    "raw": raw,
                    "media_type": "application/http",
                    "reconstructed": True,
                    "truncated": False,
                    "masked": False,
                }
            else:
                kind = "network.response"
                raw = _raw_response(exchange)
                payload = {
                    "fixture": True,
                    "request_id": request_id,
                    "status": exchange["status"],
                    "protocol": exchange["protocol"],
                    "duration_ms": 34 + exchange_index * 7,
                    "response_bytes": len(raw.encode()),
                    "raw": raw,
                    "media_type": "application/http",
                    "reconstructed": True,
                    "truncated": False,
                    "masked": False,
                }

        yield {
            "schema_version": 1,
            "provider_id": "fake",
            "provider_version": "0.1.0",
            "session_id": session_id,
            "sequence": sequence,
            "source_time_ns": 1_784_730_000_000_000_000 + sequence * 1_000_000,
            "host_time_ns": 1_784_730_000_100_000_000 + sequence * 1_000_000,
            "monotonic_time_ns": 500_000 + sequence * 1_000_000,
            "device_id": "fixture-device",
            "process_id": 42,
            "process_name": "FixtureApp",
            "evidence": "observed",
            "kind": kind,
            "payload": payload,
            "raw_ref": None,
            "parse_status": "parsed",
        }

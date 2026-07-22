import ipaddress
import struct

from proxbot_ios_provider.protocol_enrichment import (
    domain_names,
    extract_protocol_enrichment,
)


def _dns_name(name: str) -> bytes:
    return (
        b"".join(bytes([len(label)]) + label.encode() for label in name.split("."))
        + b"\0"
    )


def _ethernet_ipv4(protocol: int, payload: bytes) -> bytes:
    source = ipaddress.IPv4Address("192.168.1.30").packed
    destination = ipaddress.IPv4Address("1.1.1.1").packed
    total_length = 20 + len(payload)
    ip_header = (
        b"\x45\x00"
        + total_length.to_bytes(2, "big")
        + b"\x00\x01\x40\x00\x40"
        + bytes([protocol])
        + b"\x00\x00"
        + source
        + destination
    )
    return b"\x00" * 12 + b"\x08\x00" + ip_header + payload


def _udp(source_port: int, destination_port: int, payload: bytes) -> bytes:
    length = 8 + len(payload)
    return struct.pack("!HHHH", source_port, destination_port, length, 0) + payload


def _tcp(source_port: int, destination_port: int, payload: bytes) -> bytes:
    return (
        struct.pack("!HHII", source_port, destination_port, 1, 0)
        + b"\x50\x18"
        + b"\xff\xff\x00\x00\x00\x00"
        + payload
    )


def _client_hello(host: str, protocols: tuple[str, ...]) -> bytes:
    host_bytes = host.encode()
    server_name = b"\x00" + len(host_bytes).to_bytes(2, "big") + host_bytes
    sni_data = len(server_name).to_bytes(2, "big") + server_name
    sni = b"\x00\x00" + len(sni_data).to_bytes(2, "big") + sni_data
    protocol_list = b"".join(bytes([len(item)]) + item.encode() for item in protocols)
    alpn_data = len(protocol_list).to_bytes(2, "big") + protocol_list
    alpn = b"\x00\x10" + len(alpn_data).to_bytes(2, "big") + alpn_data
    extensions = sni + alpn
    body = (
        b"\x03\x03"
        + bytes(range(32))
        + b"\x00"
        + b"\x00\x02\x13\x01"
        + b"\x01\x00"
        + len(extensions).to_bytes(2, "big")
        + extensions
    )
    handshake = b"\x01" + len(body).to_bytes(3, "big") + body
    return b"\x16\x03\x01" + len(handshake).to_bytes(2, "big") + handshake


def test_extracts_dns_query_name_without_payload() -> None:
    question = _dns_name("Auth.Privy.IO") + b"\x00\x01\x00\x01"
    dns = b"\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00" + question
    frame = _ethernet_ipv4(17, _udp(53000, 53, dns))

    result = extract_protocol_enrichment(frame)

    assert result["dns"] == {
        "kind": "query",
        "transaction_id": 0x1234,
        "query_names": ["auth.privy.io"],
        "response_names": [],
    }
    assert result["domain_observations"] == [
        {"name": "auth.privy.io", "source": "dns.query"}
    ]
    assert domain_names(result) == ("auth.privy.io",)
    assert "payload" not in repr(result).lower()


def test_extracts_compressed_dns_response_alias_and_address() -> None:
    question = _dns_name("api.example.com") + b"\x00\x01\x00\x01"
    cname_target = _dns_name("edge.example.net")
    cname = (
        b"\xc0\x0c"
        + b"\x00\x05\x00\x01"
        + (60).to_bytes(4, "big")
        + len(cname_target).to_bytes(2, "big")
        + cname_target
    )
    address = (
        cname_target
        + b"\x00\x01\x00\x01"
        + (30).to_bytes(4, "big")
        + b"\x00\x04"
        + ipaddress.IPv4Address("203.0.113.7").packed
    )
    dns = (
        b"\xab\xcd\x81\x80\x00\x01\x00\x02\x00\x00\x00\x00" + question + cname + address
    )

    result = extract_protocol_enrichment(_ethernet_ipv4(17, _udp(53, 53000, dns)))

    assert result["dns"]["kind"] == "response"
    assert result["dns"]["response_names"] == ["api.example.com", "edge.example.net"]
    assert result["dns"]["name_records"] == [
        {
            "name": "api.example.com",
            "target": "edge.example.net",
            "type": "CNAME",
            "ttl": 60,
        }
    ]
    assert result["dns"]["address_records"] == [
        {"name": "edge.example.net", "address": "203.0.113.7", "ttl": 30}
    ]
    assert domain_names(result) == ("api.example.com", "edge.example.net")


def test_extracts_tls_client_hello_sni_and_alpn() -> None:
    hello = _client_hello("auth.privy.io", ("h2", "http/1.1"))
    frame = _ethernet_ipv4(6, _tcp(50123, 443, hello))

    result = extract_protocol_enrichment(frame)

    assert result["tls_client_hello"] == {
        "server_name": "auth.privy.io",
        "alpn_protocols": ["h2", "http/1.1"],
    }
    assert result["domain_observations"] == [
        {"name": "auth.privy.io", "source": "tls.sni"}
    ]


def test_extracts_dns_over_tcp() -> None:
    question = _dns_name("example.org") + b"\x00\x1c\x00\x01"
    dns = b"\x00\x01\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00" + question
    payload = len(dns).to_bytes(2, "big") + dns

    result = extract_protocol_enrichment(_ethernet_ipv4(6, _tcp(51000, 53, payload)))

    assert result["dns"]["query_names"] == ["example.org"]


def test_incomplete_tls_record_is_not_speculatively_parsed() -> None:
    hello = _client_hello("secret.example", ("h2",))
    frame = _ethernet_ipv4(6, _tcp(50123, 443, hello[:-4]))

    assert extract_protocol_enrichment(frame) == {}


def test_malformed_dns_pointer_loop_is_bounded() -> None:
    dns = b"\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\xc0\x0c\x00\x01\x00\x01"
    frame = _ethernet_ipv4(17, _udp(53000, 53, dns))

    assert extract_protocol_enrichment(frame) == {}


def test_oversized_or_unrelated_frame_has_no_enrichment() -> None:
    assert extract_protocol_enrichment(b"\0" * 262_145) == {}
    assert extract_protocol_enrichment(b"\0" * 64) == {}

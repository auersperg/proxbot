"""Bounded passive protocol metadata extraction for captured iOS packets.

The extractor deliberately returns only protocol metadata that is visible on
the wire: DNS names/addresses and TLS ClientHello SNI/ALPN values.  It never
returns transport payload bytes, HTTP content, TLS application data, or secret
material.  Parsing is packet-local; incomplete/reassembled streams simply
produce no enrichment rather than a speculative result.
"""

from __future__ import annotations

import ipaddress
import re
from collections.abc import Iterable
from typing import Any

_MAX_FRAME_BYTES = 262_144
_MAX_DNS_QUESTIONS = 64
_MAX_DNS_RECORDS = 256
_MAX_DNS_NAMES = 128
_MAX_DNS_POINTER_HOPS = 32
_MAX_TLS_HANDSHAKE_BYTES = 65_536
_MAX_TLS_EXTENSIONS = 128
_MAX_ALPN_PROTOCOLS = 16
_HOST_LABEL = re.compile(r"^[A-Za-z0-9_-]{1,63}$")


class _ParseError(ValueError):
    """Internal marker for malformed or incomplete untrusted wire data."""


def extract_protocol_enrichment(
    frame: bytes | bytearray | memoryview,
) -> dict[str, Any]:
    """Return bounded DNS/TLS metadata from one Ethernet frame.

    The stable result schema is intentionally sparse.  An unrelated, malformed,
    truncated, or oversized frame returns ``{}``.  Depending on what is observed,
    the mapping can contain:

    ``dns``
        ``kind`` (``query``/``response``), ``transaction_id``, bounded
        ``query_names``/``response_names``, ``address_records`` and
        ``name_records``.
    ``tls_client_hello``
        ``server_name`` and/or ``alpn_protocols`` from a complete ClientHello.
    ``domain_observations``
        De-duplicated ``{"name", "source"}`` entries suitable for endpoint
        enrichment. Sources are ``dns.query``, ``dns.response``, and ``tls.sni``.

    No transport payload is included in the return value.
    """
    try:
        data = bytes(frame)
        if not data or len(data) > _MAX_FRAME_BYTES:
            return {}
        transport = _transport_payload(data)
        if transport is None:
            return {}
        protocol, source_port, destination_port, payload = transport
        result: dict[str, Any] = {}
        observations: list[dict[str, str]] = []

        if protocol == 17 and (source_port == 53 or destination_port == 53):
            dns = _parse_dns(payload)
            if dns:
                result["dns"] = dns
                _append_dns_observations(observations, dns)
        elif protocol == 6 and (source_port == 53 or destination_port == 53):
            dns = _parse_dns_over_tcp(payload)
            if dns:
                result["dns"] = dns
                _append_dns_observations(observations, dns)

        if protocol == 6:
            client_hello = _parse_tls_client_hello(payload)
            if client_hello:
                result["tls_client_hello"] = client_hello
                server_name = client_hello.get("server_name")
                if isinstance(server_name, str):
                    _append_observation(observations, server_name, "tls.sni")

        if observations:
            result["domain_observations"] = observations
        return result
    except (_ParseError, IndexError, UnicodeError, ValueError):
        # Captured network bytes are untrusted. A malformed packet is not an
        # exceptional provider condition and must never stop the capture loop.
        return {}


def _transport_payload(frame: bytes) -> tuple[int, int, int, bytes] | None:
    if len(frame) < 14:
        raise _ParseError("truncated Ethernet header")
    ether_type = int.from_bytes(frame[12:14], "big")
    offset = 14
    vlan_count = 0
    while ether_type in {0x8100, 0x88A8}:
        vlan_count += 1
        if vlan_count > 2 or len(frame) < offset + 4:
            raise _ParseError("invalid VLAN chain")
        ether_type = int.from_bytes(frame[offset + 2 : offset + 4], "big")
        offset += 4

    protocol: int
    transport_offset: int
    transport_end: int
    if ether_type == 0x0800:
        if len(frame) < offset + 20 or frame[offset] >> 4 != 4:
            raise _ParseError("invalid IPv4 header")
        header_length = (frame[offset] & 0x0F) * 4
        total_length = int.from_bytes(frame[offset + 2 : offset + 4], "big")
        if header_length < 20 or total_length < header_length:
            raise _ParseError("invalid IPv4 length")
        if len(frame) < offset + total_length:
            raise _ParseError("truncated IPv4 packet")
        fragment_bits = int.from_bytes(frame[offset + 6 : offset + 8], "big")
        if fragment_bits & 0x1FFF:
            return None
        protocol = frame[offset + 9]
        transport_offset = offset + header_length
        transport_end = offset + total_length
    elif ether_type == 0x86DD:
        if len(frame) < offset + 40 or frame[offset] >> 4 != 6:
            raise _ParseError("invalid IPv6 header")
        protocol = frame[offset + 6]
        payload_length = int.from_bytes(frame[offset + 4 : offset + 6], "big")
        transport_offset = offset + 40
        transport_end = transport_offset + payload_length
        if payload_length == 0 or len(frame) < transport_end:
            # IPv6 jumbograms need Hop-by-Hop option parsing and are not used for
            # packet-local enrichment. Avoid guessing an implicit payload size.
            return None
        extension_count = 0
        while protocol in {0, 43, 44, 51, 60}:
            extension_count += 1
            if extension_count > 16 or transport_end < transport_offset + 2:
                raise _ParseError("invalid IPv6 extension chain")
            next_header = frame[transport_offset]
            if protocol == 44:
                extension_length = 8
                if transport_end < transport_offset + extension_length:
                    raise _ParseError("truncated IPv6 fragment header")
                fragment_bits = int.from_bytes(
                    frame[transport_offset + 2 : transport_offset + 4], "big"
                )
                if (fragment_bits >> 3) & 0x1FFF:
                    return None
            elif protocol == 51:
                extension_length = (frame[transport_offset + 1] + 2) * 4
            else:
                extension_length = (frame[transport_offset + 1] + 1) * 8
            if (
                extension_length <= 0
                or transport_end < transport_offset + extension_length
            ):
                raise _ParseError("truncated IPv6 extension")
            transport_offset += extension_length
            protocol = next_header
    else:
        return None

    if protocol == 17:
        if transport_end < transport_offset + 8:
            raise _ParseError("truncated UDP header")
        source_port = int.from_bytes(
            frame[transport_offset : transport_offset + 2], "big"
        )
        destination_port = int.from_bytes(
            frame[transport_offset + 2 : transport_offset + 4], "big"
        )
        udp_length = int.from_bytes(
            frame[transport_offset + 4 : transport_offset + 6], "big"
        )
        if udp_length < 8 or transport_offset + udp_length > transport_end:
            raise _ParseError("invalid UDP length")
        return (
            protocol,
            source_port,
            destination_port,
            frame[transport_offset + 8 : transport_offset + udp_length],
        )
    if protocol == 6:
        if transport_end < transport_offset + 20:
            raise _ParseError("truncated TCP header")
        source_port = int.from_bytes(
            frame[transport_offset : transport_offset + 2], "big"
        )
        destination_port = int.from_bytes(
            frame[transport_offset + 2 : transport_offset + 4], "big"
        )
        header_length = (frame[transport_offset + 12] >> 4) * 4
        if header_length < 20 or transport_offset + header_length > transport_end:
            raise _ParseError("invalid TCP header length")
        return (
            protocol,
            source_port,
            destination_port,
            frame[transport_offset + header_length : transport_end],
        )
    return None


def _parse_dns_over_tcp(payload: bytes) -> dict[str, Any] | None:
    if len(payload) < 2:
        return None
    message_length = int.from_bytes(payload[:2], "big")
    if (
        message_length < 12
        or message_length > 65_535
        or len(payload) < message_length + 2
    ):
        return None
    return _parse_dns(payload[2 : message_length + 2])


def _parse_dns(message: bytes) -> dict[str, Any] | None:
    if len(message) < 12 or len(message) > 65_535:
        return None
    transaction_id = int.from_bytes(message[:2], "big")
    flags = int.from_bytes(message[2:4], "big")
    question_count = int.from_bytes(message[4:6], "big")
    answer_count = int.from_bytes(message[6:8], "big")
    authority_count = int.from_bytes(message[8:10], "big")
    additional_count = int.from_bytes(message[10:12], "big")
    record_count = answer_count + authority_count + additional_count
    if question_count > _MAX_DNS_QUESTIONS or record_count > _MAX_DNS_RECORDS:
        return None

    offset = 12
    query_names: list[str] = []
    for _ in range(question_count):
        name, offset = _read_dns_name(message, offset)
        if len(message) < offset + 4:
            raise _ParseError("truncated DNS question")
        offset += 4
        _append_unique(query_names, name)

    response_names: list[str] = []
    address_records: list[dict[str, Any]] = []
    name_records: list[dict[str, Any]] = []
    for _ in range(record_count):
        owner, offset = _read_dns_name(message, offset)
        if len(message) < offset + 10:
            raise _ParseError("truncated DNS resource record")
        record_type = int.from_bytes(message[offset : offset + 2], "big")
        record_class = int.from_bytes(message[offset + 2 : offset + 4], "big")
        ttl = int.from_bytes(message[offset + 4 : offset + 8], "big")
        data_length = int.from_bytes(message[offset + 8 : offset + 10], "big")
        data_offset = offset + 10
        data_end = data_offset + data_length
        if data_end > len(message):
            raise _ParseError("truncated DNS record data")
        offset = data_end
        _append_unique(response_names, owner)

        if record_class == 1 and record_type == 1 and data_length == 4:
            address_records.append(
                {
                    "name": owner,
                    "address": str(
                        ipaddress.IPv4Address(message[data_offset:data_end])
                    ),
                    "ttl": ttl,
                }
            )
        elif record_class == 1 and record_type == 28 and data_length == 16:
            address_records.append(
                {
                    "name": owner,
                    "address": str(
                        ipaddress.IPv6Address(message[data_offset:data_end])
                    ),
                    "ttl": ttl,
                }
            )
        else:
            target_offset = _dns_name_record_offset(record_type, data_offset, data_end)
            if target_offset is not None:
                target, _ = _read_dns_name(message, target_offset, data_end)
                _append_unique(response_names, target)
                name_records.append(
                    {
                        "name": owner,
                        "target": target,
                        "type": _dns_record_type_name(record_type),
                        "ttl": ttl,
                    }
                )

        if len(response_names) > _MAX_DNS_NAMES:
            return None

    result: dict[str, Any] = {
        "kind": "response" if flags & 0x8000 else "query",
        "transaction_id": transaction_id,
        "query_names": query_names,
        "response_names": response_names,
    }
    if address_records:
        result["address_records"] = address_records
    if name_records:
        result["name_records"] = name_records
    return result


def _read_dns_name(
    message: bytes, offset: int, direct_limit: int | None = None
) -> tuple[str, int]:
    if offset < 0 or offset >= len(message):
        raise _ParseError("invalid DNS name offset")
    labels: list[str] = []
    current = offset
    next_offset: int | None = None
    pointer_hops = 0
    visited: set[int] = set()
    wire_length = 0

    while True:
        if current >= len(message):
            raise _ParseError("truncated DNS name")
        if next_offset is None and direct_limit is not None and current >= direct_limit:
            raise _ParseError("DNS name exceeds record data")
        length = message[current]
        if length & 0xC0 == 0xC0:
            if current + 1 >= len(message):
                raise _ParseError("truncated DNS pointer")
            if (
                next_offset is None
                and direct_limit is not None
                and current + 2 > direct_limit
            ):
                raise _ParseError("DNS pointer exceeds record data")
            pointer = ((length & 0x3F) << 8) | message[current + 1]
            if pointer >= len(message) or pointer in visited:
                raise _ParseError("invalid DNS pointer")
            visited.add(pointer)
            pointer_hops += 1
            if pointer_hops > _MAX_DNS_POINTER_HOPS:
                raise _ParseError("DNS pointer chain too deep")
            if next_offset is None:
                next_offset = current + 2
            current = pointer
            continue
        if length & 0xC0:
            raise _ParseError("unsupported DNS label encoding")
        current += 1
        if length == 0:
            if next_offset is None:
                next_offset = current
            break
        if length > 63 or current + length > len(message):
            raise _ParseError("invalid DNS label")
        if (
            next_offset is None
            and direct_limit is not None
            and current + length > direct_limit
        ):
            raise _ParseError("DNS label exceeds record data")
        raw_label = message[current : current + length]
        label = _decode_domain_label(raw_label)
        labels.append(label)
        wire_length += length + 1
        if wire_length > 254 or len(labels) > 127:
            raise _ParseError("DNS name too long")
        current += length

    name = ".".join(labels).lower()
    if name and len(name.encode("ascii")) > 253:
        raise _ParseError("DNS name too long")
    return name, next_offset


def _decode_domain_label(value: bytes) -> str:
    try:
        label = value.decode("ascii")
    except UnicodeDecodeError as error:
        raise _ParseError("non-ASCII DNS label") from error
    if not _HOST_LABEL.fullmatch(label):
        raise _ParseError("unsafe DNS label")
    return label


def _dns_name_record_offset(record_type: int, start: int, end: int) -> int | None:
    if record_type in {2, 5, 12}:  # NS, CNAME, PTR
        return start
    if record_type == 15 and end >= start + 3:  # MX preference + exchange
        return start + 2
    if record_type == 33 and end >= start + 7:  # SRV priority/weight/port + target
        return start + 6
    return None


def _dns_record_type_name(record_type: int) -> str:
    return {2: "NS", 5: "CNAME", 12: "PTR", 15: "MX", 33: "SRV"}.get(
        record_type, f"TYPE{record_type}"
    )


def _parse_tls_client_hello(payload: bytes) -> dict[str, Any] | None:
    if len(payload) < 5:
        return None
    handshake = bytearray()
    offset = 0
    record_count = 0
    while offset + 5 <= len(payload):
        content_type = payload[offset]
        major_version = payload[offset + 1]
        record_length = int.from_bytes(payload[offset + 3 : offset + 5], "big")
        record_end = offset + 5 + record_length
        if content_type != 22 or major_version != 3 or record_end > len(payload):
            break
        record_count += 1
        if (
            record_count > 16
            or len(handshake) + record_length > _MAX_TLS_HANDSHAKE_BYTES
        ):
            return None
        handshake.extend(payload[offset + 5 : record_end])
        offset = record_end
        if len(handshake) >= 4:
            message_length = int.from_bytes(handshake[1:4], "big")
            if message_length + 4 <= len(handshake):
                break
    if len(handshake) < 4 or handshake[0] != 1:
        return None
    message_length = int.from_bytes(handshake[1:4], "big")
    if (
        message_length > _MAX_TLS_HANDSHAKE_BYTES - 4
        or len(handshake) < message_length + 4
    ):
        return None
    hello = bytes(handshake[4 : message_length + 4])
    return _parse_client_hello_body(hello)


def _parse_client_hello_body(hello: bytes) -> dict[str, Any] | None:
    # legacy_version + random + session-id length
    if len(hello) < 35:
        return None
    offset = 34
    session_length = hello[offset]
    offset += 1 + session_length
    if offset + 2 > len(hello):
        return None
    cipher_length = int.from_bytes(hello[offset : offset + 2], "big")
    if cipher_length < 2 or cipher_length % 2:
        return None
    offset += 2 + cipher_length
    if offset >= len(hello):
        return None
    compression_length = hello[offset]
    offset += 1 + compression_length
    if offset == len(hello):
        return None
    if offset + 2 > len(hello):
        return None
    extensions_length = int.from_bytes(hello[offset : offset + 2], "big")
    offset += 2
    extensions_end = offset + extensions_length
    if extensions_end != len(hello):
        return None

    server_name: str | None = None
    alpn_protocols: list[str] = []
    extension_count = 0
    while offset < extensions_end:
        extension_count += 1
        if extension_count > _MAX_TLS_EXTENSIONS or offset + 4 > extensions_end:
            return None
        extension_type = int.from_bytes(hello[offset : offset + 2], "big")
        extension_length = int.from_bytes(hello[offset + 2 : offset + 4], "big")
        extension_start = offset + 4
        extension_end = extension_start + extension_length
        if extension_end > extensions_end:
            return None
        extension = hello[extension_start:extension_end]
        if extension_type == 0 and server_name is None:
            server_name = _parse_sni_extension(extension)
        elif extension_type == 16:
            alpn_protocols = _parse_alpn_extension(extension)
        offset = extension_end

    result: dict[str, Any] = {}
    if server_name:
        result["server_name"] = server_name
    if alpn_protocols:
        result["alpn_protocols"] = alpn_protocols
    return result or None


def _parse_sni_extension(extension: bytes) -> str | None:
    if len(extension) < 2:
        return None
    list_length = int.from_bytes(extension[:2], "big")
    if list_length != len(extension) - 2:
        return None
    offset = 2
    entries = 0
    server_name: str | None = None
    while offset < len(extension):
        entries += 1
        if entries > 16 or offset + 3 > len(extension):
            return None
        name_type = extension[offset]
        name_length = int.from_bytes(extension[offset + 1 : offset + 3], "big")
        offset += 3
        if name_length == 0 or offset + name_length > len(extension):
            return None
        raw_name = extension[offset : offset + name_length]
        offset += name_length
        if name_type == 0 and server_name is None:
            server_name = _decode_domain_name(raw_name)
            if server_name is None:
                return None
    return server_name


def _parse_alpn_extension(extension: bytes) -> list[str]:
    if len(extension) < 2:
        return []
    list_length = int.from_bytes(extension[:2], "big")
    if list_length != len(extension) - 2:
        return []
    offset = 2
    protocols: list[str] = []
    while offset < len(extension):
        length = extension[offset]
        offset += 1
        if length == 0 or offset + length > len(extension):
            return []
        try:
            protocol = extension[offset : offset + length].decode("ascii")
        except UnicodeDecodeError:
            return []
        if any(
            ord(character) < 0x21 or ord(character) > 0x7E for character in protocol
        ):
            return []
        _append_unique(protocols, protocol)
        if len(protocols) > _MAX_ALPN_PROTOCOLS:
            return []
        offset += length
    return protocols


def _decode_domain_name(value: bytes) -> str | None:
    if not value or len(value) > 253 or value.endswith(b"."):
        return None
    try:
        name = value.decode("ascii")
    except UnicodeDecodeError:
        return None
    labels = name.split(".")
    if not labels or any(not _HOST_LABEL.fullmatch(label) for label in labels):
        return None
    return name.lower()


def _append_dns_observations(
    observations: list[dict[str, str]], dns: dict[str, Any]
) -> None:
    source = "dns.response" if dns.get("kind") == "response" else "dns.query"
    for name in dns.get("query_names", []):
        _append_observation(observations, name, source)
    if dns.get("kind") == "response":
        for name in dns.get("response_names", []):
            _append_observation(observations, name, "dns.response")


def _append_observation(
    observations: list[dict[str, str]], name: str, source: str
) -> None:
    if not name or len(observations) >= _MAX_DNS_NAMES:
        return
    candidate = {"name": name, "source": source}
    if candidate not in observations:
        observations.append(candidate)


def _append_unique(values: list[str], value: str) -> None:
    if value and value not in values:
        values.append(value)


def domain_names(enrichment: dict[str, Any]) -> tuple[str, ...]:
    """Return de-duplicated names from a previously extracted result."""
    names: list[str] = []
    observations: Iterable[Any] = enrichment.get("domain_observations", [])
    for observation in observations:
        if isinstance(observation, dict) and isinstance(observation.get("name"), str):
            _append_unique(names, observation["name"])
    return tuple(names)

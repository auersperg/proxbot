import asyncio
import heapq
import signal
import socket
import time
from pathlib import Path
from typing import Any

from .log_provider import capture_logs
from .pcap_provider import capture_pcap
from .protocol import encode_frame
from .protocol_enrichment import extract_protocol_enrichment
from . import __version__


class _DnsTtlCache:
    """Bounded-in-time address/name correlation from observed DNS answers."""

    _MAX_NAMES = 16_384

    def __init__(self) -> None:
        self._entries: dict[str, dict[str, float]] = {}
        self._expiry_heap: list[tuple[float, str, str]] = []
        self._name_count = 0

    def _prune(self, now: float) -> None:
        while self._expiry_heap and (
            self._expiry_heap[0][0] <= now or self._name_count > self._MAX_NAMES
        ):
            expiry, address, name = heapq.heappop(self._expiry_heap)
            names = self._entries.get(address)
            if names is None or names.get(name) != expiry:
                # A later DNS answer refreshed this tuple; this heap entry is
                # stale and must not remove the current observation.
                continue
            names.pop(name)
            self._name_count -= 1
            if not names:
                self._entries.pop(address, None)
        if len(self._expiry_heap) > self._MAX_NAMES * 4:
            self._expiry_heap = [
                (expiry, address, name)
                for address, names in self._entries.items()
                for name, expiry in names.items()
            ]
            heapq.heapify(self._expiry_heap)

    def observe(self, enrichment: dict[str, Any], now: float) -> None:
        self._prune(now)
        dns = enrichment.get("dns")
        if not isinstance(dns, dict) or dns.get("kind") != "response":
            return
        records = dns.get("address_records")
        if not isinstance(records, list):
            return
        for record in records:
            if not isinstance(record, dict):
                continue
            address = record.get("address")
            name = record.get("name")
            ttl = record.get("ttl")
            if (
                not isinstance(address, str)
                or not isinstance(name, str)
                or not name
                or not isinstance(ttl, int)
                or isinstance(ttl, bool)
                or ttl < 0
            ):
                continue
            names = self._entries.setdefault(address, {})
            if ttl == 0:
                if names.pop(name, None) is not None:
                    self._name_count -= 1
            else:
                expiry = now + ttl
                if name not in names:
                    self._name_count += 1
                names[name] = expiry
                heapq.heappush(self._expiry_heap, (expiry, address, name))
            if not names:
                self._entries.pop(address, None)
        self._prune(now)

    def names_for(self, address: Any, now: float) -> list[str]:
        self._prune(now)
        if not isinstance(address, str):
            return []
        names = self._entries.get(address)
        if not names:
            return []
        # Prefer the most recently refreshed record while keeping the complete
        # candidate set in the payload for transparent research use.
        return [
            name
            for name, _ in sorted(
                names.items(), key=lambda item: (-item[1], item[0])
            )
        ]


class EventEmitter:
    def __init__(self, connection: socket.socket, session_id: str, device_id: str):
        self._connection = connection
        self._session_id = session_id
        self._device_id = device_id
        self._sequence = 0
        self._write_lock = asyncio.Lock()

    async def emit(
        self,
        kind: str,
        payload: dict[str, Any],
        *,
        raw_ref: dict[str, Any] | None = None,
        process_id: int | None = None,
        process_name: str | None = None,
        source_time_ns: int | None = None,
    ) -> None:
        # Packet, health, lifecycle, and marker events may be produced by
        # independent tasks.  Serialize both sequence allocation and frame
        # writes so length-prefixed socket frames can never interleave.
        async with self._write_lock:
            now = time.time_ns()
            event = {
                "schema_version": 1,
                "provider_id": "ios-live",
                "provider_version": __version__,
                "session_id": self._session_id,
                "sequence": self._sequence,
                "source_time_ns": source_time_ns if source_time_ns is not None else now,
                "host_time_ns": now,
                "monotonic_time_ns": time.monotonic_ns(),
                "device_id": self._device_id,
                "process_id": process_id,
                "process_name": process_name,
                "evidence": "observed",
                "kind": kind,
                "payload": payload,
                "raw_ref": raw_ref,
                "parse_status": "parsed",
            }
            self._sequence += 1
            await asyncio.get_running_loop().sock_sendall(
                self._connection, encode_frame(event)
            )


def artifact_metadata(
    path: Path, relative_path: str
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    present = path.is_file()
    size = path.stat().st_size if present else 0
    return (
        {"relative_path": relative_path, "size_bytes": size, "complete": present},
        {
            "relative_path": relative_path,
            "offset": 0,
            "length": size,
            "sha256": None,
        } if present else None,
    )


async def _health_loop(
    emitter: EventEmitter,
    stop: asyncio.Event,
    pcap_output: Path,
    log_output: Path,
    interval: float,
    enabled: tuple[str, ...],
) -> None:
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
        except TimeoutError:
            await emitter.emit(
                "provider.health",
                {
                    "pcap_bytes": pcap_output.stat().st_size
                    if pcap_output.is_file()
                    else 0,
                    "log_bytes": log_output.stat().st_size
                    if log_output.is_file()
                    else 0,
                    "coverage": [
                        coverage
                        for provider, coverage in (
                            ("pcap", "encrypted_network_packets"),
                            ("syslog", "device_syslog"),
                        )
                        if provider in enabled
                    ],
                    "application_plaintext": False,
                    "tls_decryption": False,
                },
            )


async def _wait_provider_outputs(
    tasks: list[asyncio.Task[dict[str, Any]]],
    expected_outputs: tuple[Path, ...],
    timeout_seconds: float = 30.0,
) -> None:
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    while True:
        completed = next((task for task in tasks if task.done()), None)
        if completed is not None:
            failure = completed.exception()
            if failure is not None:
                raise failure
            raise RuntimeError(f"{completed.get_name()} provider ended during startup")
        if all(path.is_file() for path in expected_outputs):
            return
        if asyncio.get_running_loop().time() >= deadline:
            missing = ", ".join(str(path) for path in expected_outputs if not path.is_file())
            raise TimeoutError(f"capture providers did not initialize: {missing}")
        await asyncio.sleep(0.05)


async def run_live_capture(
    socket_path: Path,
    session_id: str,
    udid: str,
    pcap_output: Path,
    log_output: Path,
    health_interval: float = 1.0,
    providers: tuple[str, ...] = ("pcap", "syslog"),
    _stop_event: asyncio.Event | None = None,
) -> None:
    """Capture real USB packet/log evidence until SIGINT/SIGTERM."""

    stop = _stop_event or asyncio.Event()
    enabled = tuple(dict.fromkeys(providers))
    if not enabled or any(provider not in {"pcap", "syslog"} for provider in enabled):
        raise ValueError("providers must contain pcap and/or syslog")
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(signum, stop.set)
        except (NotImplementedError, RuntimeError):
            pass

    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.setblocking(False)
    await loop.sock_connect(connection, str(socket_path))
    emitter = EventEmitter(connection, session_id, udid)
    providers: list[asyncio.Task[dict[str, Any]]] = []
    health: asyncio.Task[None] | None = None
    failure: BaseException | None = None
    initialized = False
    packet_emission_ready = asyncio.Event()
    # IP addresses can legitimately have multiple DNS names (CDNs and shared
    # hosting). Keep all unexpired observations instead of pretending there is
    # a permanent one-to-one mapping. Expiry uses monotonic time, so host clock
    # corrections cannot extend an observation beyond its wire TTL.
    dns_cache = _DnsTtlCache()
    try:
        providers = []
        if "pcap" in enabled:
            packet_index = 0

            async def emit_packet(
                packet: Any,
                metadata: dict[str, Any],
                raw_ref: dict[str, Any],
            ) -> None:
                nonlocal packet_index
                # pcapd can yield immediately.  Rust requires provider.ready to
                # be sequence zero, so hold packets until startup is committed.
                await packet_emission_ready.wait()
                packet_index += 1
                direction = metadata["direction"]
                source = metadata.get("source_ip")
                destination = metadata.get("destination_ip")
                source_port = metadata.get("source_port")
                destination_port = metadata.get("destination_port")
                remote_ip = (
                    destination
                    if direction == "outbound"
                    else source if direction == "inbound" else None
                )
                enrichment = extract_protocol_enrichment(bytes(packet.data))
                observed_at = time.monotonic()
                dns_cache.observe(enrichment, observed_at)
                tls = enrichment.get("tls_client_hello")
                server_name = (
                    tls.get("server_name")
                    if isinstance(tls, dict) and isinstance(tls.get("server_name"), str)
                    else None
                )
                cached_names = dns_cache.names_for(remote_ip, observed_at)
                host = server_name or (cached_names[0] if cached_names else None)
                host_source = (
                    "tls.sni" if server_name else "dns.ttl_cache" if host else None
                )
                def endpoint(address: Any, port: Any) -> str:
                    if not address:
                        return "unknown"
                    rendered = str(address)
                    if port is None:
                        return rendered
                    if ":" in rendered:
                        rendered = f"[{rendered}]"
                    return f"{rendered}:{port}"
                summary = (
                    f"{direction.upper()} {metadata['protocol']} "
                    f"{endpoint(source, source_port)} → {endpoint(destination, destination_port)} "
                    f"({metadata['packet_bytes']} bytes)"
                )
                payload = {
                    "request_id": f"ios-live:packet:{packet_index:012d}",
                    "method": (
                        "OUT"
                        if direction == "outbound"
                        else "IN" if direction == "inbound" else "PACKET"
                    ),
                    "host": host,
                    "host_source": host_source,
                    "domain_candidates": (
                        [server_name]
                        if server_name is not None
                        else cached_names
                    ),
                    "ip": remote_ip,
                    "path": f"{endpoint(source, source_port)} → {endpoint(destination, destination_port)}",
                    "protocol": metadata["protocol"],
                    "request_bytes": metadata["packet_bytes"],
                    "raw": summary,
                    "media_type": "text/plain; charset=utf-8",
                    "reconstructed": True,
                    "truncated": False,
                    "masked": False,
                    "direction": direction,
                    "interface": metadata.get("interface"),
                    "source_ip": source,
                    "destination_ip": destination,
                    "source_port": source_port,
                    "destination_port": destination_port,
                    "packet_bytes": metadata["packet_bytes"],
                    "warning": "packet_metadata",
                }
                if enrichment:
                    payload["protocol_enrichment"] = enrichment
                seconds = int(getattr(packet, "seconds", 0))
                microseconds = int(getattr(packet, "microseconds", 0))
                timestamp = seconds * 1_000_000_000 + microseconds * 1_000
                timestamp = timestamp or None
                await emitter.emit(
                    "network.packet",
                    payload,
                    raw_ref=raw_ref,
                    process_id=metadata.get("process_id"),
                    process_name=metadata.get("process_name"),
                    source_time_ns=timestamp,
                )

            providers.append(asyncio.create_task(capture_pcap(pcap_output, udid, -1, emit_packet), name="pcap"))
        if "syslog" in enabled:
            providers.append(asyncio.create_task(capture_logs(log_output, udid, -1), name="syslog"))
        expected_outputs = tuple(
            output
            for provider, output in (("pcap", pcap_output), ("syslog", log_output))
            if provider in enabled
        )
        await _wait_provider_outputs(providers, expected_outputs)
        initialized = True
        await emitter.emit(
            "provider.ready",
            {
                "fixture": False,
                "provider": "ios-live",
                "capabilities": list(enabled),
                "coverage": [
                    coverage
                    for provider, coverage in (
                        ("pcap", "encrypted_network_packets"),
                        ("syslog", "device_syslog"),
                    )
                    if provider in enabled
                ],
                "capture_initialized": True,
                "application_plaintext": False,
                "tls_decryption": False,
            },
        )
        packet_emission_ready.set()
        health = asyncio.create_task(
            _health_loop(emitter, stop, pcap_output, log_output, health_interval, enabled),
            name="health",
        )
        stop_task = asyncio.create_task(stop.wait(), name="stop")
        done, _ = await asyncio.wait(
            [stop_task, *providers], return_when=asyncio.FIRST_COMPLETED
        )
        if stop_task not in done:
            completed = next(task for task in done if task in providers)
            failure = completed.exception() or RuntimeError(
                f"{completed.get_name()} provider ended unexpectedly"
            )
            stop.set()
        stop_task.cancel()
        await asyncio.gather(stop_task, return_exceptions=True)
    except BaseException as error:
        failure = error
    finally:
        stop.set()
        if health is not None:
            health.cancel()
        for task in providers:
            task.cancel()
        results = await asyncio.gather(
            *(providers + ([health] if health is not None else [])),
            return_exceptions=True,
        )
        if failure is None:
            failure = next(
                (
                    result
                    for result in results
                    if isinstance(result, BaseException)
                    and not isinstance(result, asyncio.CancelledError)
                ),
                None,
            )
        artifacts = []
        if "pcap" in enabled:
            artifacts.append(("artifact.pcap", pcap_output, "capture/device.pcapng"))
        if "syslog" in enabled:
            artifacts.append(("artifact.syslog", log_output, "logs/device.jsonl"))
        if initialized:
            for kind, path, relative in artifacts:
                payload, raw_ref = artifact_metadata(path, relative)
                if not payload["complete"]:
                    failure = failure or RuntimeError(f"missing capture artifact: {relative}")
                await emitter.emit(kind, payload, raw_ref=raw_ref)
        if failure is not None:
            await emitter.emit(
                "provider.error", {"message": str(failure), "recoverable": False}
            )
        await emitter.emit(
            "provider.stopped",
            {"reason": "provider_failure" if failure else "requested"},
        )
        connection.close()
    if failure is not None:
        raise failure

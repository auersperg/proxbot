import json
import os
import time
from collections.abc import AsyncIterable, AsyncIterator
from pathlib import Path
from typing import Any

from .secure_output import open_owner_only


async def iter_log_records(
    lines: AsyncIterable[str], count: int = -1, clock_ns=time.time_ns
) -> AsyncIterator[dict[str, Any]]:
    sequence = 0
    async for line in lines:
        yield {"sequence": sequence, "host_time_ns": clock_ns(), "raw": line}
        sequence += 1
        if sequence == count:
            break


async def capture_logs(
    output: Path, udid: str | None = None, count: int = -1
) -> dict[str, Any]:
    from pymobiledevice3.lockdown import create_using_usbmux
    from pymobiledevice3.services.syslog import SyslogService

    lockdown = await create_using_usbmux(
        serial=udid, connection_type="USB", autopair=False
    )
    service = SyslogService(lockdown)
    output.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    try:
        with open_owner_only(output, "w") as stream:
            async for record in iter_log_records(service.watch(), count=count):
                stream.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")))
                stream.write("\n")
                written += 1
            stream.flush()
            os.fsync(stream.fileno())
        return {
            "path": str(output),
            "record_count": written,
            "size_bytes": output.stat().st_size,
        }
    finally:
        await service.service.close()
        await lockdown.close()

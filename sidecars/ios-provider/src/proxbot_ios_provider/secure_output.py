import os
from pathlib import Path
from typing import BinaryIO, Literal, TextIO, overload


@overload
def open_owner_only(
    path: Path, mode: Literal["w"],
) -> TextIO: ...


@overload
def open_owner_only(
    path: Path, mode: Literal["wb"],
) -> BinaryIO: ...


def open_owner_only(path: Path, mode: Literal["w", "wb"]) -> TextIO | BinaryIO:
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_CLOEXEC | os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        if mode == "w":
            return os.fdopen(descriptor, mode, encoding="utf-8")
        return os.fdopen(descriptor, mode)
    except BaseException:
        os.close(descriptor)
        raise

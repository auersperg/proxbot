from __future__ import annotations

import os
import stat
from pathlib import Path


def ensure_owner_directory(path: Path) -> Path:
    absolute = path.absolute()
    current = Path(absolute.anchor)
    platform_root_aliases = {Path("/tmp"), Path("/var")}
    for part in absolute.parts[1:]:
        current /= part
        if current.exists() and current.is_symlink() and current not in platform_root_aliases:
            raise ValueError(f"artifact path must not contain symlinks: {current}")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.is_symlink() or not path.is_dir():
        raise ValueError(f"artifact directory is not a real directory: {path}")
    os.chmod(path, 0o700)
    return path


def validate_owner_directory(path: Path) -> Path:
    metadata = os.lstat(path)
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise ValueError(f"directory is not a real directory: {path}")
    if metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) & 0o077:
        raise ValueError(f"directory must be owned by the current user with mode 0700: {path}")
    return path


def open_append_owner_only(path: Path) -> int:
    ensure_owner_directory(path.parent)
    flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_CLOEXEC | os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    os.fchmod(descriptor, 0o600)
    return descriptor

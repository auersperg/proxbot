import os
import stat

import pytest

from proxbot_ios_provider.secure_output import open_owner_only


@pytest.mark.parametrize(
    ("mode", "payload"),
    [("w", "sensitive log\n"), ("wb", b"sensitive packet")],
)
def test_open_owner_only_enforces_0600_independent_of_umask(tmp_path, mode, payload):
    output = tmp_path / "capture-output"
    previous_umask = os.umask(0)
    try:
        with open_owner_only(output, mode) as stream:
            stream.write(payload)
    finally:
        os.umask(previous_umask)

    assert stat.S_IMODE(output.stat().st_mode) == 0o600


def test_open_owner_only_tightens_an_existing_file(tmp_path):
    output = tmp_path / "capture-output"
    output.write_text("old", encoding="utf-8")
    output.chmod(0o644)

    with open_owner_only(output, "w") as stream:
        stream.write("replacement")

    assert output.read_text(encoding="utf-8") == "replacement"
    assert stat.S_IMODE(output.stat().st_mode) == 0o600


def test_open_owner_only_refuses_a_symlink_target(tmp_path):
    target = tmp_path / "target"
    target.write_text("preserve", encoding="utf-8")
    output = tmp_path / "capture-output"
    output.symlink_to(target)

    with pytest.raises(OSError):
        open_owner_only(output, "w")

    assert target.read_text(encoding="utf-8") == "preserve"

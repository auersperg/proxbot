#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT/sidecars/ios-provider"
BUILD_ROOT="$ROOT/.provider-build"
TARGET_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
DESTINATION="$ROOT/src-tauri/binaries/proxbot-ios-provider-$TARGET_TRIPLE"

mkdir -p "$BUILD_ROOT" "$(dirname "$DESTINATION")"

uv run --project "$PROJECT" --extra build --locked \
  pyinstaller \
  --noconfirm \
  --clean \
  --onefile \
  --name proxbot-ios-provider \
  --distpath "$BUILD_ROOT/dist" \
  --workpath "$BUILD_ROOT/work" \
  --specpath "$BUILD_ROOT" \
  --paths "$PROJECT/src" \
  "$PROJECT/provider_entry.py"

cp "$BUILD_ROOT/dist/proxbot-ios-provider" "$DESTINATION"
chmod 0755 "$DESTINATION"

PROBE="$("$DESTINATION" probe)"
python3 - "$PROBE" <<'PY'
import json
import sys

probe = json.loads(sys.argv[1])
if probe.get("available") is not True or probe.get("provider") != "ios-live":
    raise SystemExit(f"invalid bundled iOS provider probe: {probe!r}")
if probe.get("frida_version") != "17.16.4":
    raise SystemExit(f"unexpected bundled Frida runtime: {probe!r}")
if probe.get("generic_app_store_process_injection") is not False:
    raise SystemExit(f"bundled probe overstates stock iOS capabilities: {probe!r}")
PY

shasum -a 256 "$DESTINATION"

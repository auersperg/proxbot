#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT/sidecars/proxy-provider"
BUILD_ROOT="$ROOT/.provider-build/proxy"
TARGET_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
DESTINATION="$ROOT/src-tauri/binaries/proxbot-proxy-provider-$TARGET_TRIPLE"

mkdir -p "$BUILD_ROOT" "$(dirname "$DESTINATION")"

# mitmproxy loads protocol addons and its dump frontend dynamically. Collecting
# both packages in full keeps the one-file sidecar independent from a checkout,
# Python installation, or an external mitmdump console script. The proxbot addon
# remains a data file because mitmproxy intentionally loads it through `-s`.
uv run --project "$PROJECT" --extra build --locked \
  pyinstaller \
  --noconfirm \
  --clean \
  --onefile \
  --name proxbot-proxy-provider \
  --distpath "$BUILD_ROOT/dist" \
  --workpath "$BUILD_ROOT/work" \
  --specpath "$BUILD_ROOT" \
  --paths "$PROJECT/src" \
  --collect-all mitmproxy \
  --collect-all mitmproxy_rs \
  --hidden-import proxbot_proxy_provider.addon \
  --add-data "$PROJECT/src/proxbot_proxy_provider/mitm_addon.py:proxbot_proxy_provider" \
  "$PROJECT/provider_entry.py"

cp "$BUILD_ROOT/dist/proxbot-proxy-provider" "$DESTINATION"
chmod 0755 "$DESTINATION"

PROBE="$($DESTINATION probe)"
python3 - "$PROBE" <<'PY'
import json
import sys

probe = json.loads(sys.argv[1])
if probe.get("available") is not True or probe.get("provider") != "proxy-mitm":
    raise SystemExit(f"invalid bundled proxy probe: {probe!r}")
if probe.get("mitmdump") not in {"embedded", "mitmdump"} and not probe.get("mitmdump"):
    raise SystemExit(f"bundled proxy has no mitmdump runtime: {probe!r}")
PY

shasum -a 256 "$DESTINATION"

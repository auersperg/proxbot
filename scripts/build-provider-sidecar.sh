#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT/sidecars/ios-provider"
BUILD_ROOT="$ROOT/.provider-build"
TARGET_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
DESTINATION="$ROOT/src-tauri/binaries/proxbot-ios-provider-$TARGET_TRIPLE"

mkdir -p "$BUILD_ROOT" "$(dirname "$DESTINATION")"

uv run --project "$PROJECT" --with 'pyinstaller==6.21.0' \
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
"$DESTINATION" --help >/dev/null
shasum -a 256 "$DESTINATION"

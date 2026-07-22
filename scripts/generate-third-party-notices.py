#!/usr/bin/env python3
"""Generate a deterministic dependency inventory shipped inside the app bundle."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
out = ROOT / "third-party" / "THIRD_PARTY_LICENSES.txt"
parts = [
    "proxbot third-party dependency inventory\n",
    "Generated from the repository's committed lockfiles. Copyright and license terms remain with each project.\n",
    (ROOT / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8"),
]
for relative in ["bun.lock", "src-tauri/Cargo.lock", "sidecars/ios-provider/uv.lock", "sidecars/proxy-provider/uv.lock"]:
    text = (ROOT / relative).read_text(encoding="utf-8")
    if relative == "bun.lock":
        names = sorted(set(re.findall(r'^\s*"(@?[^"\s]+)": \["[^"@]*@([^"\s]+)"', text, re.M)))
    else:
        blocks = re.findall(r'(?ms)^\[\[package\]\]\s*(.*?)(?=^\[\[package\]\]|\Z)', text)
        names = []
        for block in blocks:
            name = re.search(r'^name = "([^"]+)"', block, re.M)
            version = re.search(r'^version = "([^"]+)"', block, re.M)
            if name and version:
                names.append((name.group(1), version.group(1)))
        names = sorted(set(names))
    parts.append(f"\n=== {relative} ===\n")
    parts.extend(f"{name} {version}\n" for name, version in names)
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text("".join(parts), encoding="utf-8")
print(out)

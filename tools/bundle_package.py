#!/usr/bin/env python3
"""Bundle an NBT node-package directory into an installable ``.nbtpack``.

Usage:
    python tools/bundle_package.py PACKAGE_DIR [-o OUTPUT] [--force]

PACKAGE_DIR is a folder containing your node ``.py`` files and (recommended)
an ``nbt-package.json`` manifest:

    {
      "name": "file",
      "version": "1.0.0",
      "description": "...",
      "requirements": ["somelib>=1.0"]
    }

The script validates the manifest, makes sure at least one node file is
present, skips junk (``__pycache__``, ``.git``, ``*.pyc``, dot-files and the
output bundle itself), and writes ``<name>-<version>.nbtpack`` — a zip whose
contents are nested under a single ``<name>/`` folder, exactly what NBT's
package manager expects (git URL or zip upload).

Examples:
    python tools/bundle_package.py packages/nbt-file-nodes
    python tools/bundle_package.py packages/nbt-file-nodes -o dist/file.nbtpack
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import zipfile
from pathlib import Path

MANIFEST_NAME = "nbt-package.json"
SKIP_DIR_NAMES = {"__pycache__", ".git", ".github", "node_modules", ".idea",
                  ".vscode"}


def _safe_name(name: str) -> str:
    name = re.sub(r"[^A-Za-z0-9_-]+", "_", (name or "").strip()).strip("_-")
    return name or "package"


def _included(rel: Path) -> bool:
    parts = rel.parts
    if any(p in SKIP_DIR_NAMES for p in parts):
        return False
    if any(p.startswith(".") for p in parts):       # dot-files / dot-dirs
        return False
    if rel.suffix in (".pyc", ".pyo", ".nbtpack"):
        return False
    if rel.name == ".DS_Store":
        return False
    return True


def _has_node_file(files: list[Path]) -> bool:
    for rel in files:
        if rel.suffix == ".py" and not any(
                p.startswith(("_", ".")) for p in rel.parts):
            return True
    return False


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Bundle an NBT node package into a .nbtpack")
    ap.add_argument("package_dir", help="folder containing the node files")
    ap.add_argument("-o", "--output", help="output .nbtpack path")
    ap.add_argument("--force", action="store_true",
                    help="overwrite the output if it exists")
    args = ap.parse_args()

    src = Path(args.package_dir).resolve()
    if not src.is_dir():
        print(f"error: not a directory: {src}", file=sys.stderr)
        return 2

    # ---- manifest (optional, but validated if present) ----
    manifest: dict = {}
    mpath = src / MANIFEST_NAME
    if mpath.exists():
        try:
            manifest = json.loads(mpath.read_text())
        except json.JSONDecodeError as e:
            print(f"error: invalid {MANIFEST_NAME}: {e}", file=sys.stderr)
            return 2
        if not isinstance(manifest, dict):
            print(f"error: {MANIFEST_NAME} must be a JSON object",
                  file=sys.stderr)
            return 2
        reqs = manifest.get("requirements", [])
        if reqs is not None and not isinstance(reqs, list):
            print("error: 'requirements' must be a list of strings",
                  file=sys.stderr)
            return 2
    else:
        print(f"warning: no {MANIFEST_NAME} found; deriving defaults",
              file=sys.stderr)

    name = _safe_name(manifest.get("name") or src.name)
    version = str(manifest.get("version") or "dev")

    # ---- collect files ----
    files = sorted(
        rel for rel in (p.relative_to(src) for p in src.rglob("*") if p.is_file())
        if _included(rel))
    if not files:
        print("error: no files to bundle", file=sys.stderr)
        return 2
    if not _has_node_file(files):
        print("error: no node files (*.py) found in the package",
              file=sys.stderr)
        return 2

    # ---- output path ----
    out = Path(args.output) if args.output else Path(f"{name}-{version}.nbtpack")
    out = out.resolve()
    if out.exists() and not args.force:
        print(f"error: {out} exists (use --force to overwrite)",
              file=sys.stderr)
        return 2
    out.parent.mkdir(parents=True, exist_ok=True)

    # ---- write the zip (nested under a single <name>/ folder) ----
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in files:
            z.write(src / rel, f"{name}/{rel.as_posix()}")

    py = sum(1 for r in files if r.suffix == ".py")
    print(f"bundled '{name}' v{version} -> {out}")
    print(f"  {len(files)} files ({py} .py), "
          f"{out.stat().st_size} bytes")
    if manifest.get("requirements"):
        print(f"  requirements: {', '.join(manifest['requirements'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

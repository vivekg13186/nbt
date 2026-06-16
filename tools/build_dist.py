#!/usr/bin/env python3
"""Build a standalone, distributable NBT zip.

Steps:
  1. Build the React UI (``cd webui && npm ci && npm run build``) unless
     ``--skip-frontend`` is passed and ``webui/dist`` already exists.
  2. Assemble a clean staging folder: the Python app, core ``nodes/``, the
     built ``webui/dist``, docs, example packages and run helpers — excluding
     ``node_modules``, ``venv``, ``.git``, caches and any local database.
  3. Zip it to ``dist/nbt-<version>.zip``.

The recipient unzips, then:
    pip install -r requirements.txt
    python api_server.py            # http://localhost:8000
(or runs the bundled ``run.sh`` / ``run.bat``).

Usage:
    python tools/build_dist.py
    python tools/build_dist.py --version 1.2.0
    python tools/build_dist.py --skip-frontend        # reuse existing dist
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
import zipfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# directory names skipped anywhere in a copied tree
SKIP_DIRS = {"__pycache__", ".git", ".github", "node_modules", "venv",
             ".venv", ".idea", ".vscode", ".pytest_cache", "dist", "build"}
SKIP_SUFFIX = {".pyc", ".pyo"}
SKIP_NAMES = {".DS_Store", ".nbt-packages.json"}

RUN_SH = """#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
python3 -m pip install -r requirements.txt
exec python3 api_server.py "$@"
"""

RUN_BAT = """@echo off
cd /d "%~dp0"
python -m pip install -r requirements.txt
python api_server.py %*
"""

DIST_README = """# NBT — distributable build

A web-based node editor / test runner. This bundle already contains the built
web UI, so you only need Python 3.10+.

## Run

```bash
pip install -r requirements.txt
python api_server.py            # open http://localhost:8000
```

Or use the helper: `./run.sh` (macOS/Linux) or `run.bat` (Windows).

The database is created on first launch at `data/nbt.db` (a Demo Flow is
seeded). Custom node packages can be installed from the **Packages** view.
See `docs/` and the source `README.md` for details.
"""


def _ignore(_dir, names):
    out = []
    for n in names:
        if n in SKIP_DIRS or n in SKIP_NAMES:
            out.append(n)
        elif any(n.endswith(s) for s in SKIP_SUFFIX):
            out.append(n)
    return out


def build_frontend() -> None:
    webui = ROOT / "webui"
    npm = shutil.which("npm")
    if npm is None:
        print("error: npm not found; install Node.js or use --skip-frontend",
              file=sys.stderr)
        sys.exit(2)
    print("building web UI (npm ci && npm run build)…")
    lock = webui / "package-lock.json"
    cmd = [npm, "ci"] if lock.exists() else [npm, "install"]
    subprocess.run(cmd, cwd=webui, check=True)
    subprocess.run([npm, "run", "build"], cwd=webui, check=True)


def main() -> int:
    ap = argparse.ArgumentParser(description="Build a distributable NBT zip")
    ap.add_argument("--version", default=date.today().isoformat(),
                    help="version label for the output zip")
    ap.add_argument("--skip-frontend", action="store_true",
                    help="reuse an existing webui/dist instead of rebuilding")
    ap.add_argument("-o", "--output", help="output zip path")
    args = ap.parse_args()

    dist = ROOT / "webui" / "dist"
    if args.skip_frontend:
        if not dist.is_dir():
            print("error: webui/dist not found; drop --skip-frontend",
                  file=sys.stderr)
            return 2
        print("reusing existing webui/dist")
    else:
        build_frontend()

    name = f"nbt-{args.version}"
    staging_root = Path(tempfile.mkdtemp(prefix="nbt-dist-"))
    stage = staging_root / name
    stage.mkdir(parents=True)

    # ---- top-level files ----
    for f in ["api_server.py", "main.py", "requirements.txt", "README.md"]:
        src = ROOT / f
        if src.exists():
            shutil.copy2(src, stage / f)

    # ---- trees ----
    shutil.copytree(ROOT / "nbt", stage / "nbt", ignore=_ignore)
    shutil.copytree(ROOT / "nodes", stage / "nodes", ignore=_ignore)
    shutil.copytree(dist, stage / "webui" / "dist", ignore=_ignore)
    for opt in ["docs", "packages", "tools", "tests"]:
        d = ROOT / opt
        if d.is_dir():
            shutil.copytree(d, stage / opt, ignore=_ignore)

    # ---- fresh, empty data dir (DB seeded on first launch) ----
    (stage / "data").mkdir(exist_ok=True)
    (stage / "data" / ".gitkeep").write_text("")

    # ---- run helpers + readme ----
    sh = stage / "run.sh"
    sh.write_text(RUN_SH)
    sh.chmod(0o755)
    (stage / "run.bat").write_text(RUN_BAT)
    (stage / "DISTRIBUTION.md").write_text(DIST_README)

    # ---- zip ----
    out = Path(args.output) if args.output else ROOT / "dist" / f"{name}.zip"
    out = out.resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()
    file_count = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(stage.rglob("*")):
            if p.is_file():
                z.write(p, p.relative_to(staging_root).as_posix())
                file_count += 1

    shutil.rmtree(staging_root, ignore_errors=True)
    size_mb = out.stat().st_size / 1e6
    print(f"\nbuilt {out}")
    print(f"  {file_count} files, {size_mb:.1f} MB")
    print("  recipient: unzip, `pip install -r requirements.txt`, "
          "`python api_server.py`")
    return 0


if __name__ == "__main__":
    sys.exit(main())

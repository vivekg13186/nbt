"""Node package manager.

A *node package* is a folder of one or more node ``.py`` files placed under
``nodes/<name>/`` (the registry scans sub-folders recursively). A package may
include an optional manifest ``nbt-package.json``::

    {
      "name": "pg",
      "version": "1.0.0",
      "description": "Postgres nodes",
      "author": "you",
      "requirements": ["psycopg2-binary>=2.9"]
    }

Packages can be installed from a git URL or from a zip bundle (``.nbtpack`` /
``.zip``). Declared ``requirements`` are pip-installed into the running
environment. Installed packages are tracked in a hidden lockfile
``nodes/.nbt-packages.json`` (ignored by the node scanner, which skips
dot-files).
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

MANIFEST_NAME = "nbt-package.json"
LOCKFILE_NAME = ".nbt-packages.json"


class PackageError(Exception):
    """Installing / removing a node package failed."""


def _safe_name(name: str) -> str:
    name = re.sub(r"[^A-Za-z0-9_-]+", "_", (name or "").strip()).strip("_-")
    return name or "package"


def _has_node_files(folder: Path) -> bool:
    for p in folder.rglob("*.py"):
        rel = p.relative_to(folder)
        if not any(part.startswith((".", "_")) for part in rel.parts):
            return True
    return False


def _count_nodes(folder: Path) -> int:
    n = 0
    for p in folder.rglob("*.py"):
        rel = p.relative_to(folder)
        if not any(part.startswith((".", "_")) for part in rel.parts):
            n += 1
    return n


class PackageManager:
    def __init__(self, nodes_dir, registry=None):
        self.nodes_dir = Path(nodes_dir)
        self.registry = registry  # optional, for reloading after changes
        self.nodes_dir.mkdir(parents=True, exist_ok=True)

    # ---------------- lockfile ----------------
    @property
    def lockfile(self) -> Path:
        return self.nodes_dir / LOCKFILE_NAME

    def _read_lock(self) -> dict:
        try:
            return json.loads(self.lockfile.read_text())
        except Exception:
            return {}

    def _write_lock(self, data: dict) -> None:
        self.lockfile.write_text(json.dumps(data, indent=2))

    # ---------------- listing ----------------
    def list(self) -> list[dict]:
        lock = self._read_lock()
        out: dict[str, dict] = {}
        for name, meta in lock.items():
            folder = self.nodes_dir / name
            out[name] = {
                **meta,
                "name": name,
                "installed": folder.is_dir(),
                "node_count": _count_nodes(folder) if folder.is_dir() else 0,
            }
        # also surface folders added manually (not via the manager)
        for child in sorted(self.nodes_dir.iterdir()):
            if (child.is_dir() and not child.name.startswith((".", "_"))
                    and child.name not in out and _has_node_files(child)):
                out[child.name] = {
                    "name": child.name, "version": None,
                    "source": {"type": "local"}, "installed": True,
                    "requirements": [], "node_count": _count_nodes(child),
                }
        return sorted(out.values(), key=lambda p: p["name"].lower())

    # ---------------- install ----------------
    def install_git(self, url: str, ref: str | None = None) -> dict:
        url = (url or "").strip()
        if not url:
            raise PackageError("git URL is required")
        if shutil.which("git") is None:
            raise PackageError("git is not installed on the server")
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "clone"
            cmd = ["git", "clone", "--depth", "1"]
            if ref:
                cmd += ["--branch", ref]
            cmd += [url, str(dest)]
            proc = subprocess.run(cmd, capture_output=True, text=True)
            if proc.returncode != 0:
                raise PackageError(
                    "git clone failed: " + (proc.stderr.strip() or "unknown"))
            shutil.rmtree(dest / ".git", ignore_errors=True)
            default_name = _safe_name(
                re.sub(r"\.git$", "", url.rstrip("/").split("/")[-1]))
            source = {"type": "git", "url": url, "ref": ref}
            return self._install_from_dir(dest, default_name, source)

    def install_zip(self, data: bytes, filename: str = "package.zip") -> dict:
        with tempfile.TemporaryDirectory() as tmp:
            zpath = Path(tmp) / "pkg.zip"
            zpath.write_bytes(data)
            extract = Path(tmp) / "extract"
            extract.mkdir()
            try:
                with zipfile.ZipFile(zpath) as zf:
                    _safe_extract(zf, extract)
            except zipfile.BadZipFile:
                raise PackageError("not a valid zip file")
            base = re.sub(r"\.(nbtpack|zip)$", "", filename or "package",
                          flags=re.I)
            default_name = _safe_name(Path(base).name)
            return self._install_from_dir(
                extract, default_name, {"type": "zip", "filename": filename})

    def _install_from_dir(self, src_root: Path, default_name: str,
                          source: dict) -> dict:
        root = self._find_package_root(src_root)
        manifest = self._read_manifest(root)
        name = _safe_name(manifest.get("name") or default_name)
        target = self.nodes_dir / name
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)
        shutil.copytree(root, target,
                        ignore=shutil.ignore_patterns(".git", "__pycache__"))

        requirements = manifest.get("requirements") or []
        pip_log = self._pip_install(requirements) if requirements else ""

        entry = {
            "name": name,
            "version": manifest.get("version"),
            "description": manifest.get("description"),
            "author": manifest.get("author"),
            "requirements": requirements,
            "source": source,
            "installed_at": time.time(),
        }
        lock = self._read_lock()
        lock[name] = entry
        self._write_lock(lock)

        load_errors = self._reload()
        return {"package": {**entry, "installed": True,
                            "node_count": _count_nodes(target)},
                "pip_log": pip_log, "load_errors": load_errors}

    # ---------------- update / remove ----------------
    def update(self, name: str) -> dict:
        lock = self._read_lock()
        entry = lock.get(name)
        if entry is None:
            raise PackageError(f"package '{name}' is not managed (no source)")
        source = entry.get("source") or {}
        if source.get("type") == "git":
            return self.install_git(source.get("url"), source.get("ref"))
        raise PackageError(
            f"package '{name}' was installed from a {source.get('type')} "
            "bundle; re-upload it to update")

    def remove(self, name: str) -> dict:
        name = _safe_name(name)
        target = self.nodes_dir / name
        if target.is_dir():
            shutil.rmtree(target, ignore_errors=True)
        lock = self._read_lock()
        existed = lock.pop(name, None) is not None
        self._write_lock(lock)
        if not existed and not target.exists():
            # nothing was there
            pass
        load_errors = self._reload()
        return {"removed": name, "load_errors": load_errors}

    # ---------------- helpers ----------------
    def _reload(self):
        if self.registry is not None:
            self.registry.load()
            return [{"file": f, "error": e} for f, e in self.registry.errors]
        return []

    def _find_package_root(self, folder: Path) -> Path:
        """Locate the folder that actually holds the node files / manifest."""
        if (folder / MANIFEST_NAME).exists() or _has_node_files(folder):
            # prefer the level with the manifest if a sole subdir has it
            if not (folder / MANIFEST_NAME).exists():
                subdirs = [d for d in folder.iterdir() if d.is_dir()
                           and not d.name.startswith((".", "__"))]
                if (len(subdirs) == 1 and not _top_has_py(folder)
                        and (subdirs[0] / MANIFEST_NAME).exists()):
                    return subdirs[0]
            return folder
        # descend into a single wrapping directory (common in zips)
        subdirs = [d for d in folder.iterdir() if d.is_dir()
                   and not d.name.startswith((".", "__"))]
        if len(subdirs) == 1:
            return self._find_package_root(subdirs[0])
        raise PackageError(
            "no node files (*.py) found in the package")

    def _read_manifest(self, root: Path) -> dict:
        mpath = root / MANIFEST_NAME
        if not mpath.exists():
            return {}
        try:
            data = json.loads(mpath.read_text())
            return data if isinstance(data, dict) else {}
        except Exception as e:
            raise PackageError(f"invalid {MANIFEST_NAME}: {e}")

    def _pip_install(self, requirements: list[str]) -> str:
        if not requirements:
            return ""
        cmd = [sys.executable, "-m", "pip", "install",
               "--disable-pip-version-check", *requirements]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        log = (proc.stdout or "") + (proc.stderr or "")
        if proc.returncode != 0:
            raise PackageError("pip install failed:\n" + log[-2000:])
        return log[-2000:]


def _top_has_py(folder: Path) -> bool:
    return any(p.suffix == ".py" and not p.name.startswith("_")
               for p in folder.iterdir() if p.is_file())


def _safe_extract(zf: zipfile.ZipFile, dest: Path) -> None:
    """Extract a zip, refusing path traversal (zip slip)."""
    dest = dest.resolve()
    for member in zf.namelist():
        target = (dest / member).resolve()
        if not str(target).startswith(str(dest)):
            raise PackageError(f"unsafe path in zip: {member}")
    zf.extractall(dest)

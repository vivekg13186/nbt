"""Auto-discovery of custom nodes from the nodes/ folder."""

import importlib.util
import inspect
import logging
import sys
from pathlib import Path

from .node_base import BaseNode

log = logging.getLogger("nbt.registry")


class NodeRegistry:
    """Scans a directory for BaseNode subclasses and registers them."""

    def __init__(self, nodes_dir):
        self.nodes_dir = Path(nodes_dir)
        self.types = {}      # type_name -> class
        self.errors = []     # list of (filename, error string)

    def load(self):
        """(Re)scan the nodes directory recursively. Safe to call repeatedly.

        ``.py`` files are discovered in ``nodes/`` and all of its sub-folders,
        so custom nodes can be grouped (e.g. ``nodes/pg/insert.py``). Files and
        directories whose name starts with ``_`` or ``.`` (including
        ``__pycache__``) are skipped. A node's top-level sub-folder is used as
        its default ``category`` when the class doesn't set one.
        """
        self.types.clear()
        self.errors.clear()
        if not self.nodes_dir.is_dir():
            log.warning("nodes directory not found: %s", self.nodes_dir)
            return self

        for path in sorted(self.nodes_dir.rglob("*.py")):
            rel = path.relative_to(self.nodes_dir)
            if any(part.startswith("_") or part.startswith(".")
                   for part in rel.parts):
                continue  # private file or under __pycache__/.hidden dir
            # top-level sub-folder name, if the file lives in one
            group = rel.parts[0] if len(rel.parts) > 1 else None
            self._load_file(path, rel, group)
        return self

    def _load_file(self, path: Path, rel: Path, group):
        # unique, import-safe module name from the path relative to nodes/
        mod_name = "nbt_user_nodes_" + "_".join(rel.with_suffix("").parts)
        label = str(rel)  # shown in error messages (includes sub-folder)
        try:
            spec = importlib.util.spec_from_file_location(mod_name, path)
            module = importlib.util.module_from_spec(spec)
            sys.modules[mod_name] = module
            spec.loader.exec_module(module)
        except Exception as e:  # a broken node file must not kill the app
            self.errors.append((label, f"{type(e).__name__}: {e}"))
            log.exception("failed to load node file %s", path)
            return

        found = False
        for _, cls in inspect.getmembers(module, inspect.isclass):
            if (issubclass(cls, BaseNode) and cls is not BaseNode
                    and cls.__module__ == mod_name):
                if not cls.type_name or cls.type_name == "base":
                    self.errors.append(
                        (label, f"{cls.__name__} has no unique type_name"))
                    continue
                if cls.type_name in self.types:
                    self.errors.append(
                        (label, f"duplicate type_name '{cls.type_name}'"))
                    continue
                # default the palette category to the sub-folder name
                if group and (not cls.category or cls.category == "General"):
                    cls.category = group
                self.types[cls.type_name] = cls
                found = True
        if not found:
            log.info("no node classes found in %s", label)

    def get(self, type_name):
        return self.types.get(type_name)

    def by_category(self):
        """Return {category: [(type_name, class), ...]} sorted."""
        cats = {}
        for tname, cls in sorted(self.types.items()):
            cats.setdefault(cls.category or "General", []).append((tname, cls))
        return dict(sorted(cats.items()))

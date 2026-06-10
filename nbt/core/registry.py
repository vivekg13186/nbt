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
        """(Re)scan the nodes directory. Safe to call repeatedly."""
        self.types.clear()
        self.errors.clear()
        if not self.nodes_dir.is_dir():
            log.warning("nodes directory not found: %s", self.nodes_dir)
            return self

        for path in sorted(self.nodes_dir.glob("*.py")):
            if path.name.startswith("_"):
                continue
            self._load_file(path)
        return self

    def _load_file(self, path: Path):
        mod_name = f"nbt_user_nodes_{path.stem}"
        try:
            spec = importlib.util.spec_from_file_location(mod_name, path)
            module = importlib.util.module_from_spec(spec)
            sys.modules[mod_name] = module
            spec.loader.exec_module(module)
        except Exception as e:  # a broken node file must not kill the app
            self.errors.append((path.name, f"{type(e).__name__}: {e}"))
            log.exception("failed to load node file %s", path)
            return

        found = False
        for _, cls in inspect.getmembers(module, inspect.isclass):
            if (issubclass(cls, BaseNode) and cls is not BaseNode
                    and cls.__module__ == mod_name):
                if not cls.type_name or cls.type_name == "base":
                    self.errors.append(
                        (path.name, f"{cls.__name__} has no unique type_name"))
                    continue
                if cls.type_name in self.types:
                    self.errors.append(
                        (path.name, f"duplicate type_name '{cls.type_name}'"))
                    continue
                self.types[cls.type_name] = cls
                found = True
        if not found:
            log.info("no node classes found in %s", path.name)

    def get(self, type_name):
        return self.types.get(type_name)

    def by_category(self):
        """Return {category: [(type_name, class), ...]} sorted."""
        cats = {}
        for tname, cls in sorted(self.types.items()):
            cats.setdefault(cls.category or "General", []).append((tname, cls))
        return dict(sorted(cats.items()))

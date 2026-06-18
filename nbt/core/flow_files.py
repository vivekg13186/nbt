"""Read / write workflow files in JSON or YAML.

A workflow file is a small wrapper around the graph so a flow's **name** and
**folder** travel with it (instead of being inferred from the file name):

    name: My Flow
    folder: Billing            # optional; omit / null for the top level
    graph:
      nodes: [ ... ]
      links: [ ... ]
      groups: [ ... ]          # optional UI metadata
      notes:  [ ... ]          # optional UI metadata

Both JSON and YAML use the same shape. For backward compatibility a *bare
graph* file (an object whose top level is just ``nodes`` / ``links``) is also
accepted on import — its name then comes from the file name and it has no
folder. See ``docs/FLOW_FILES.md``.
"""

from __future__ import annotations

import json
import os
import re

import yaml


def safe_filename(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9 _.\-]+", "_", s or "").strip() or "flow"


def flow_doc(flow: dict) -> dict:
    """The serializable document for a flow row (name + folder + graph)."""
    return {
        "name": flow.get("name"),
        "folder": (flow.get("folder") or None),
        "graph": flow.get("graph") or {"nodes": [], "links": []},
    }


def dump_flow(flow: dict, fmt: str = "json") -> tuple[str, str, str]:
    """Serialize a flow. Returns (content, extension, media_type)."""
    doc = flow_doc(flow)
    if (fmt or "json").lower() in ("yaml", "yml"):
        content = yaml.safe_dump(doc, sort_keys=False, allow_unicode=True)
        return content, "yaml", "application/x-yaml"
    return json.dumps(doc, indent=2), "json", "application/json"


def parse_flow_doc(text: str, filename: str = "") -> dict:
    """Parse a JSON/YAML workflow file into {name, folder, graph}.

    `name` / `folder` are None when the file doesn't specify them (the caller
    decides the fallbacks, e.g. the file name). Raises ValueError on a file
    that isn't a recognizable workflow.
    """
    ext = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    data = None
    if ext in ("yaml", "yml"):
        data = yaml.safe_load(text)
    else:
        try:
            data = json.loads(text)
        except Exception:
            # tolerate YAML content in a file without a .yaml extension
            data = yaml.safe_load(text)
    if not isinstance(data, dict):
        raise ValueError("not a workflow file (expected a mapping at the top)")

    if isinstance(data.get("graph"), dict):
        graph = data["graph"]
        name = data.get("name")
        folder = data.get("folder")
    elif isinstance(data.get("nodes"), list):
        # bare graph (legacy / hand-written): the file itself is the graph
        graph = data
        name = None
        folder = None
    else:
        raise ValueError(
            'not a workflow file (need a "graph" object or a "nodes" array)')

    graph = {
        "nodes": graph.get("nodes") or [],
        "links": graph.get("links") or [],
        **({"groups": graph["groups"]} if "groups" in graph else {}),
        **({"notes": graph["notes"]} if "notes" in graph else {}),
    }
    return {
        "name": (str(name).strip() if name else None),
        "folder": (str(folder).strip() if folder else None),
        "graph": graph,
    }


def name_from_filename(filename: str) -> str:
    stem = os.path.splitext(os.path.basename(filename or ""))[0]
    return stem.strip() or "Imported flow"

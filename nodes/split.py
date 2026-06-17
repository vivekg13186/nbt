"""Fan-out (split / source) nodes for normal Runs.

A *split* node runs its downstream subgraph once per item — the Run equivalent
of the Emit Array trigger, but inline (no Listen). For each element the engine
seeds `item` and `index` into the context and runs every node reachable from
the split; iterations are independent (one failing item doesn't stop the rest
unless `stop_on_error` is set, and the Run fails if any item failed).

  * **Split** — fan out over a JSON array (or a `{{ template }}` that yields a
    list, e.g. an environment variable or an upstream node's output).
  * **Split CSV** — fan out over the rows of a CSV file; each `item` is a dict
    keyed by the header row (or a list of cells when `has_header` is false).
"""

import csv
import json

from nbt.core.node_base import SplitNode


def _as_list(raw):
    """Coerce a list, a JSON-array string, or None into a Python list."""
    if isinstance(raw, (list, tuple)):
        return list(raw)
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return []
        try:
            parsed = json.loads(s)
        except Exception:
            return None
        return parsed if isinstance(parsed, list) else None
    return None


class Split(SplitNode):
    type_name = "split"
    label = "Split (Fan-out)"
    category = "Flow"
    inputs = {"items": "[]", "stop_on_error": False}
    outputs = ["item", "index"]

    def items(self, inputs, ctx):
        lst = _as_list(inputs.get("items"))
        if lst is None:
            raise ValueError(
                "items must be a JSON array (e.g. [1, 2, 3]) or a "
                "{{ template }} that yields a list")
        return lst


class SplitCsv(SplitNode):
    type_name = "split_csv"
    label = "Split CSV"
    category = "Flow"
    inputs = {"path": "", "has_header": True, "delimiter": ",",
              "stop_on_error": False}
    outputs = ["item", "index"]

    def items(self, inputs, ctx):
        path = str(inputs.get("path") or "").strip()
        if not path:
            raise ValueError("path to a .csv file is required")
        delim = (str(inputs.get("delimiter") or ",") or ",")[0]
        with open(path, newline="", encoding="utf-8-sig") as f:
            if inputs.get("has_header"):
                return [dict(row) for row in csv.DictReader(f, delimiter=delim)]
            return [row for row in csv.reader(f, delimiter=delim)]

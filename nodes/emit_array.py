"""Emit Array: a streaming source that emits each element of an array.

Give it `items` as a JSON array (e.g. `[1, 2, 3]` or `["a", "b"]`) or a
`{{ template }}` that yields a list (e.g. an environment variable). Each
element fires the rest of the flow once — one recorded execution per element —
with `item` and `index` available downstream. Emits are synchronous, so
elements are processed one at a time in order (no drops), and the listener
auto-stops after the last element. Arm it with **Listen**.
"""

import json
import threading

from nbt.core.node_base import TriggerNode


class EmitArray(TriggerNode):
    type_name = "emit_array"
    label = "Emit Array"
    category = "Triggers"
    inputs = {"items": "[]"}
    outputs = ["item", "index"]

    def start(self, emit, inputs, ctx):
        self._stop = threading.Event()

        # normalize the input to a list
        raw = inputs.get("items")
        items = None
        if isinstance(raw, (list, tuple)):
            items = list(raw)
        elif isinstance(raw, str):
            s = raw.strip()
            try:
                parsed = json.loads(s) if s else []
            except Exception:
                parsed = None
            if isinstance(parsed, list):
                items = parsed

        def finish():
            fin = getattr(self, "finish", None)  # injected by the listener
            if fin:
                try:
                    fin()
                except Exception:
                    pass

        def run():
            if items is None:  # not a valid array -> nothing to emit
                finish()
                return
            for i, el in enumerate(items):
                if self._stop.is_set():
                    break
                # synchronous: blocks until this element's flow run completes
                emit({"item": el, "index": i})
            if not self._stop.is_set():
                finish()  # auto-disarm after the last element

        threading.Thread(target=run, daemon=True).start()

    def stop(self):
        if hasattr(self, "_stop"):
            self._stop.set()

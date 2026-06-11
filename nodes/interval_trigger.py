"""Emits an event every N seconds (e.g. 300 = every 5 minutes)."""

import threading
import time

from nbt.core.node_base import TriggerNode


class IntervalTrigger(TriggerNode):
    type_name = "interval_trigger"
    label = "Interval Trigger"
    category = "Triggers"
    inputs = {"seconds": 300.0, "emit_immediately": False}
    outputs = ["tick", "time"]

    def start(self, emit, inputs, ctx):
        self._stop = threading.Event()
        secs = max(0.05, float(inputs["seconds"]))
        immediately = bool(inputs["emit_immediately"])

        def loop():
            n = 0
            if immediately:
                n += 1
                emit({"tick": n, "time": time.time()})
            while not self._stop.wait(secs):
                n += 1
                emit({"tick": n, "time": time.time()})

        threading.Thread(target=loop, daemon=True).start()

    def stop(self):
        self._stop.set()

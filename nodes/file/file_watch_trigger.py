"""Emits an event when a file is created, modified or deleted (polling)."""

import os
import threading

from nbt.core.node_base import TriggerNode


class FileWatchTrigger(TriggerNode):
    type_name = "file_watch_trigger"
    label = "File Watch Trigger"
    category = "File"
    inputs = {"path": "", "poll_seconds": 2.0}
    outputs = ["path", "event", "mtime"]

    def start(self, emit, inputs, ctx):
        self._stop = threading.Event()
        path = str(inputs["path"]).strip()
        poll = max(0.1, float(inputs["poll_seconds"]))

        def mtime():
            try:
                return os.path.getmtime(path)
            except OSError:
                return None

        def loop():
            prev = mtime()
            while not self._stop.wait(poll):
                cur = mtime()
                if cur == prev:
                    continue
                if prev is None:
                    event = "created"
                elif cur is None:
                    event = "deleted"
                else:
                    event = "modified"
                prev = cur
                emit({"path": path, "event": event, "mtime": cur})

        threading.Thread(target=loop, daemon=True).start()

    def stop(self):
        self._stop.set()

"""Streaming source: read a file and emit it line by line.

Each line fires the rest of the flow once (one recorded execution per line),
with ``line`` and ``lineno`` available downstream. Emits are synchronous, so
lines are processed one at a time in order — no line is dropped even for a
fast flow. Arm it with **Listen**.

By default it emits every existing line once and then stops the listener at
end-of-file (batch mode). Turn on ``tail`` to keep the file open and emit new
lines as they are appended, like ``tail -f`` (runs until you press Stop).
"""

import threading
import time

from nbt.core.node_base import TriggerNode


class FileLinesTrigger(TriggerNode):
    type_name = "file_lines_trigger"
    label = "File Lines"
    category = "File"
    inputs = {
        "path": "",
        "tail": False,          # False: stop at EOF; True: keep streaming
        "strip": True,          # strip surrounding whitespace from each line
        "skip_empty": False,    # skip blank lines
        "encoding": "utf-8",
    }
    outputs = ["line", "lineno"]

    def start(self, emit, inputs, ctx):
        self._stop = threading.Event()
        path = str(inputs.get("path") or "").strip()
        tail = bool(inputs.get("tail"))
        strip = bool(inputs.get("strip"))
        skip_empty = bool(inputs.get("skip_empty"))
        encoding = inputs.get("encoding") or "utf-8"

        def finish():
            fin = getattr(self, "finish", None)  # injected by the listener
            if fin:
                try:
                    fin()
                except Exception:
                    pass

        def run():
            n = 0
            if not path:
                finish()
                return
            try:
                f = open(path, "r", encoding=encoding)
            except Exception:
                finish()  # can't open -> disarm
                return
            with f:
                while not self._stop.is_set():
                    line = f.readline()
                    if line == "":          # EOF
                        if tail:
                            time.sleep(0.3)
                            continue
                        break
                    n += 1
                    text = line.strip() if strip else line.rstrip("\r\n")
                    if skip_empty and text == "":
                        continue
                    # synchronous: blocks until this line's flow run completes
                    emit({"line": text, "lineno": n})
            if not tail and not self._stop.is_set():
                finish()  # batch mode: auto-disarm at end of file

        threading.Thread(target=run, daemon=True).start()

    def stop(self):
        if hasattr(self, "_stop"):
            self._stop.set()

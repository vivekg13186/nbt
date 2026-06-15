"""Log node: write a message to the Log tab and pass it downstream.

The message is a normal string input, so `{{ ... }}` templates work, e.g.
`status = {{ last['status'] }}`. It prints to the Log tab (and the CLI on
headless runs) and outputs the rendered message so it can be chained.
"""

from nbt.core.node_base import BaseNode


class LogNode(BaseNode):
    type_name = "log"
    label = "Log"
    category = "Utility"
    inputs = {"message": ""}
    outputs = ["message"]

    def run(self, inputs, ctx):
        msg = "" if inputs["message"] is None else str(inputs["message"])
        log = ctx.get("log")
        if callable(log):
            log(msg)
        return {"message": msg}

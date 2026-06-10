"""Pause the flow for N seconds."""

import time

from nbt.core.node_base import BaseNode


class Delay(BaseNode):
    type_name = "delay"
    label = "Delay"
    category = "Utility"
    inputs = {"seconds": 1.0}
    outputs = ["slept"]

    def run(self, inputs, ctx):
        secs = max(0.0, float(inputs["seconds"]))
        time.sleep(secs)
        return {"slept": secs}

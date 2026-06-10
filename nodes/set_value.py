"""Set a value into the flow context."""

from nbt.core.node_base import BaseNode


class SetValue(BaseNode):
    type_name = "set_value"
    label = "Set Value"
    category = "Data"
    inputs = {"value": ""}
    outputs = ["value"]

    def run(self, inputs, ctx):
        return {"value": inputs["value"]}

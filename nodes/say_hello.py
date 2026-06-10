"""Evaluate a Python expression against the flow context."""

from nbt.core.node_base import BaseNode
from nbt.core.engine import safe_eval


class PythonEval(BaseNode):
    type_name = "say_hello"
    label = "Say Hello"
    category = "API"
    inputs = {"name": "asdasd"}
    outputs = ["message"]

    def run(self, inputs, ctx):
        return {"value": "Hello"+safe_eval(str(inputs["expression"]), ctx)}
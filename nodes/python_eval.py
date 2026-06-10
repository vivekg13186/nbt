"""Evaluate a Python expression against the flow context."""

from nbt.core.node_base import BaseNode
from nbt.core.engine import safe_eval


class PythonEval(BaseNode):
    type_name = "python_eval"
    label = "Python Eval"
    category = "Data"
    inputs = {"expression": "1 + 1"}
    outputs = ["value"]

    def run(self, inputs, ctx):
        return {"value": safe_eval(str(inputs["expression"]), ctx)}

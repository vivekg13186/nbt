"""Assert two values are equal. Use {{ expr }} to reference previous nodes."""

from nbt.core.node_base import BaseNode, AssertionFailure


class AssertEquals(BaseNode):
    type_name = "assert_equals"
    label = "Assert Equals"
    category = "Asserts"
    inputs = {"actual": "{{ last['value'] }}", "expected": ""}
    outputs = ["actual", "expected"]

    def run(self, inputs, ctx):
        return {"actual": inputs["actual"], "expected": inputs["expected"]}

    def check(self, outputs, inputs, ctx):
        a, e = outputs["actual"], outputs["expected"]
        if a != e and str(a) != str(e):
            raise AssertionFailure(f"expected {e!r} but got {a!r}")

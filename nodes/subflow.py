"""Subflow node: run another saved flow as a single step.

Give it the target flow's `name` and an `inputs` JSON object of variables to
seed into that flow (the subflow's nodes can read them as plain names). The
subflow runs as its own recorded execution. Outputs:

* `output` — a dict of all the subflow's published output aliases (alias it to
  e.g. `sub`, then read `sub['result']`)
* `execution_id` — the subflow's execution id
* `status` — the subflow's status

Recursive calls are detected and fail cleanly.
"""

import json

from nbt.core.node_base import BaseNode, NodeError


class Subflow(BaseNode):
    type_name = "subflow"
    label = "Subflow"
    category = "Flow"
    inputs = {"flow": "", "inputs": "{}"}
    outputs = ["output", "execution_id", "status"]

    def run(self, inputs, ctx):
        run_flow = ctx.get("run_flow")
        if not callable(run_flow):
            raise NodeError("subflow is not supported in this run context")
        name = str(inputs["flow"]).strip()
        if not name:
            raise NodeError("flow (target flow name) is required")

        raw = inputs["inputs"]
        seed = {}
        if isinstance(raw, dict):
            seed = raw
        elif raw not in (None, ""):
            try:
                seed = json.loads(str(raw))
            except Exception as e:
                raise NodeError(f"inputs is not valid JSON: {e}")
            if not isinstance(seed, dict):
                raise NodeError("inputs must be a JSON object")

        res = run_flow(name, seed)
        if res.get("status") != "passed":
            raise NodeError(
                f"subflow '{name}' {res.get('status')}: "
                f"{res.get('error') or ''}".strip())

        log = ctx.get("log")
        if callable(log):
            log(f"subflow '{name}' -> execution {res.get('execution_id')}")

        # pack all the subflow's published aliases under a single `output`
        return {
            "output": dict(res.get("outputs") or {}),
            "execution_id": res.get("execution_id"),
            "status": res.get("status"),
        }

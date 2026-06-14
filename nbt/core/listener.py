"""Listener runtime: arms a trigger-headed flow and runs it on each event.

A flow whose start node is a TriggerNode is not Run - it is *listened to*.
FlowListener arms the trigger (cls.start) and, for every emitted event,
executes the rest of the flow with the trigger's outputs seeded into the
context. The trigger node's `pre` field filters events (falsy ->
event ignored, no execution recorded). Overlapping events are dropped while
a run is still in progress (counted in `skipped_busy`).
"""

import threading

from .engine import (FlowValidationError, _name, build_dag, resolve_value,
                     safe_eval)


class FlowListener:
    def __init__(self, engine, flow, environment=None, env_vars=None,
                 on_run_done=None):
        self.engine = engine
        self.flow = flow
        self.environment = environment
        self.env_vars = env_vars or {}
        self.on_run_done = on_run_done  # called after each triggered run

        self.active = False
        self.events = 0          # events emitted by the trigger
        self.runs = 0            # executions actually started
        self.filtered = 0        # events dropped by the pre filter
        self.skipped_busy = 0    # events dropped because a run was ongoing
        self.last_result = None  # (exec_id, status, error) of latest run

        self._busy = threading.Lock()
        self._instance = None
        self._tnode = None

    def _env_ctx(self):
        ctx = {}
        if self.env_vars:
            ctx["env"] = dict(self.env_vars)
            for k, v in self.env_vars.items():
                if isinstance(k, str) and k not in ("last", "ctx", "env"):
                    ctx[k] = v
        return ctx

    def start(self):
        """Validate the flow and arm its trigger. Raises on bad flows.

        The trigger node may be standalone (no outgoing connection) or the
        root of a subgraph. Exactly one trigger node is supported per flow.
        """
        nodes, order, _parents, _children = build_dag(self.flow["graph"])
        triggers = []
        for nid in order:
            cls = self.engine.registry.get(nodes[nid].get("type"))
            if cls is not None and getattr(cls, "is_trigger", False):
                triggers.append((nodes[nid], cls))
        if not triggers:
            raise FlowValidationError(
                "flow has no trigger node to listen to (use Run instead)")
        if len(triggers) > 1:
            names = ", ".join(_name(t) for t, _ in triggers)
            raise FlowValidationError(
                f"flow has multiple trigger nodes ({names}); keep exactly "
                "one to Listen")
        self._tnode, cls = triggers[0]

        ctx = self._env_ctx()
        inputs = {}
        for pname, default in cls.inputs.items():
            raw = self._tnode.get("params", {}).get(pname, default)
            inputs[pname] = resolve_value(raw, ctx)

        self._instance = cls()
        self.active = True
        try:
            self._instance.start(self._emit, inputs, ctx)
        except Exception:
            self.active = False
            raise

    def _emit(self, outputs):
        if not self.active:
            return
        self.events += 1
        outputs = outputs if isinstance(outputs, dict) else {"value": outputs}

        cond = (self._tnode.get("pre") or self._tnode.get("condition") or "").strip()
        if cond:
            cctx = self._env_ctx()
            cctx[_name(self._tnode)] = outputs
            cctx["last"] = outputs
            try:
                if not safe_eval(cond, cctx):
                    self.filtered += 1
                    return
            except Exception:
                self.filtered += 1  # broken filter -> drop event, keep alive
                return

        if not self._busy.acquire(blocking=False):
            self.skipped_busy += 1
            return
        try:
            self.runs += 1
            self.last_result = self.engine.execute(
                self.flow["id"], self.flow["name"], self.flow["graph"],
                environment=self.environment, env_vars=self.env_vars,
                trigger_node=self._tnode, trigger_outputs=outputs)
        finally:
            self._busy.release()

        if self.on_run_done is not None:
            try:
                self.on_run_done(self)
            except Exception:
                pass  # GUI callback errors must not kill the listener

    def stop(self):
        self.active = False
        if self._instance is not None:
            try:
                self._instance.stop()
            except Exception:
                pass
            self._instance = None

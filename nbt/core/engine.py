"""Flow validation and execution engine (DAG model).

Execution model:
  * A flow is a directed acyclic graph. Nodes may have multiple inputs and
    multiple outputs; branches and joins are allowed. The only structural
    rule is "no cycles" — multiple roots and several disconnected subgraphs
    are fine.
  * Nodes execute in topological order. A node's `last` is the outputs of its
    first connected upstream parent (output aliases are the robust way to
    reference any specific upstream node).
  * If a node's `pre` expression evaluates falsy, the node is SKIPPED and its
    descendants still run (with `last` falling through to the next available
    parent).
  * A node executes by instantiating its class and calling run(); it fails if
    run() raises, if the class check() hook raises, or if the node's `post`
    expression is falsy / raises.
  * If any node fails, the whole flow fails immediately. Otherwise it passes.

Trigger (listener) nodes are not Run — they are armed via Listen. A trigger
need not be connected to anything; when it fires, the subgraph reachable from
it executes with the trigger's outputs seeded into the context.

Expressions (pre / post / {{ templates }} in string inputs) are
evaluated against the execution context:
  * `ctx`  - dict of {node name: outputs dict} for already-executed nodes
  * `last` - outputs of the first connected upstream parent
  * `ins`  - list of outputs of ALL connected parents, in order (for join
    nodes, e.g. `ins[1]['value']`)
  * node names that are valid identifiers are also available directly,
    e.g. `get_user['status'] == 200`
"""

import builtins
import json
import re
import time
import traceback

from .node_base import AssertionFailure

_TEMPLATE_RE = re.compile(r"\{\{(.*?)\}\}", re.S)

_SAFE_BUILTIN_NAMES = (
    "len", "str", "int", "float", "bool", "abs", "min", "max", "round",
    "sum", "any", "all", "sorted", "list", "dict", "tuple", "set", "repr",
    "isinstance", "range", "enumerate", "zip", "type", "True", "False",
    "None",
)
_SAFE_BUILTINS = {n: getattr(builtins, n)
                  for n in _SAFE_BUILTIN_NAMES if hasattr(builtins, n)}


class FlowValidationError(Exception):
    """The flow graph is structurally invalid."""


def _eval_env(ctx):
    env = {"ctx": ctx, "last": ctx.get("last")}
    for k, v in ctx.items():
        if isinstance(k, str) and k.isidentifier():
            env[k] = v
    return env


def safe_eval(expr, ctx):
    """Evaluate an expression with restricted builtins against the context."""
    return eval(expr, {"__builtins__": _SAFE_BUILTINS}, _eval_env(ctx))


def resolve_value(value, ctx):
    """Resolve {{ expr }} templates inside string values.

    If the entire string is a single template, the raw evaluated object is
    returned (so non-string values can be passed between nodes).
    """
    if not isinstance(value, str):
        return value
    full = _TEMPLATE_RE.fullmatch(value.strip())
    if full:
        return safe_eval(full.group(1).strip(), ctx)
    return _TEMPLATE_RE.sub(
        lambda m: str(safe_eval(m.group(1).strip(), ctx)), value)


def build_dag(graph):
    """Validate the graph and return (nodes, order, parents, children).

    `nodes`    - {id: node dict}
    `order`    - list of node ids in a valid topological order
    `parents`  - {id: [parent ids]} in link declaration order
    `children` - {id: [child ids]} in link declaration order

    The only structural rule is acyclicity. Multiple roots, branches, joins
    and several disconnected subgraphs are all allowed. Stale links (pointing
    at missing nodes) are ignored. Duplicate node ids (e.g. from a copy-paste
    in an older editor) are de-duplicated so no node is silently dropped.
    """
    nodes = {}
    for n in graph.get("nodes", []):
        nid = n.get("id")
        if not nid or nid in nodes:  # missing or duplicate -> make it unique
            base = nid or (n.get("type") or "node")
            i = 2
            new = f"{base}__{i}"
            while new in nodes:
                i += 1
                new = f"{base}__{i}"
            n = {**n, "id": new}
            nid = new
        nodes[nid] = n
    if not nodes:
        raise FlowValidationError("Flow has no nodes.")

    parents = {nid: [] for nid in nodes}
    children = {nid: [] for nid in nodes}
    for link in graph.get("links", []):
        src, dst = link[0], link[1]
        if src not in nodes or dst not in nodes:
            continue  # stale link
        if dst not in children[src]:
            children[src].append(dst)
            parents[dst].append(src)

    # Kahn's algorithm — stable, preserving node insertion order for roots.
    indeg = {nid: len(parents[nid]) for nid in nodes}
    queue = [nid for nid in nodes if indeg[nid] == 0]
    order = []
    while queue:
        nid = queue.pop(0)
        order.append(nid)
        for c in children[nid]:
            indeg[c] -= 1
            if indeg[c] == 0:
                queue.append(c)

    if len(order) != len(nodes):
        done = set(order)
        cyclic = [_name(nodes[nid]) for nid in nodes if nid not in done]
        raise FlowValidationError(
            "Flow contains a cycle involving: " + ", ".join(cyclic))
    return nodes, order, parents, children


def _descendants(start, children):
    """All node ids reachable from `start` (excluding `start` itself)."""
    seen, stack = set(), list(children.get(start, []))
    while stack:
        nid = stack.pop()
        if nid in seen:
            continue
        seen.add(nid)
        stack.extend(children.get(nid, []))
    return seen




def _name(node):
    return node.get("name") or node.get("type") or node.get("id", "?")


def _json(obj):
    try:
        return json.dumps(obj, default=repr)
    except Exception:
        return json.dumps(repr(obj))


class Engine:
    """Runs flows and records results to the database."""

    def __init__(self, registry, db):
        self.registry = registry
        self.db = db

    def execute(self, flow_id, flow_name, graph, environment=None,
                env_vars=None, trigger_node=None, trigger_outputs=None,
                log=None, media=None, seed_vars=None, out_collector=None,
                call_stack=None):
        """Run a flow graph as a DAG. Returns (execution_id, status, error).

        `env_vars` (dict) are injected into the context before any node:
        available as `env['key']` and, for identifier-safe keys, directly as
        `key` in expressions / `ctx['key']` in node code.

        Optional callables, exposed to nodes via the context:
          * `log(str)`        -> `ctx["log"]` (streamed to the Log tab)
          * `media(path)`     -> `ctx["media"]` (publish a file, returns a URL)
        and `ctx["run_flow"](name, vars)` runs another flow as a subflow.

        Listener runtime: pass `trigger_node` (the trigger's node dict) and
        `trigger_outputs`. The trigger's outputs are seeded into the context
        and only the subgraph reachable from it is executed.

        Subflow runtime: `seed_vars` (dict) are seeded as named variables;
        `out_collector` (dict) is filled with the published output aliases;
        `call_stack` carries the chain of flow names for recursion detection.
        """
        log_fn = log if callable(log) else (lambda *_a, **_k: None)
        exec_id = self.db.create_execution(flow_id, flow_name, environment)
        self._media = media if callable(media) else None
        try:
            nodes, order, parents, children = build_dag(graph)
        except FlowValidationError as e:
            self.db.finish_execution(exec_id, "error", str(e))
            return exec_id, "error", str(e)

        reserved = ("last", "ctx", "env", "ins", "log", "media", "run_flow")
        ctx = {}
        if env_vars:
            ctx["env"] = dict(env_vars)
            for k, v in env_vars.items():
                if isinstance(k, str) and k not in reserved:
                    ctx[k] = v
        # subflow inputs: seed as named variables (override env)
        if seed_vars:
            for k, v in seed_vars.items():
                if isinstance(k, str) and k not in reserved:
                    ctx[k] = v

        # published alias collector (used when this run is a subflow)
        published = out_collector if out_collector is not None else {}

        # ctx["run_flow"](name, vars) runs another saved flow as a subflow
        stack = list(call_stack or [flow_name])
        ctx["run_flow"] = lambda name, vars=None: self._run_subflow(
            name, environment, env_vars, vars or {}, stack, log_fn, self._media)

        node_outputs = {}  # id -> outputs, used to resolve each node's `last`

        if trigger_node is not None:
            # Listener path: seed the trigger and run only its descendants.
            tid = trigger_node.get("id")
            tname = _name(trigger_node)
            outputs = (trigger_outputs if isinstance(trigger_outputs, dict)
                       else {"value": trigger_outputs})
            now = time.time()
            self.db.add_step(
                exec_id, tid, tname, trigger_node.get("type"), "passed",
                None, _json({}), _json(outputs), now, now)
            ctx[tname] = outputs
            node_outputs[tid] = outputs
            for oname, alias in (trigger_node.get("out_aliases") or {}).items():
                alias = str(alias).strip()
                if alias and alias != "last" and oname in outputs:
                    ctx[alias] = outputs[oname]
            reachable = _descendants(tid, children)
            run_ids = [nid for nid in order if nid in reachable]
        else:
            # Run path: execute every node; triggers must be armed via Listen.
            for nid in order:
                cls = self.registry.get(nodes[nid].get("type"))
                if cls is not None and getattr(cls, "is_trigger", False):
                    err = (f"flow contains trigger node "
                           f"'{_name(nodes[nid])}' - use Listen to arm it")
                    self.db.finish_execution(exec_id, "error", err)
                    return exec_id, "error", err
            run_ids = order

        for nid in run_ids:
            node = nodes[nid]
            # outputs of every connected parent that produced any, in order
            ins = [node_outputs[p] for p in parents.get(nid, [])
                   if p in node_outputs]
            last = ins[0] if ins else {}
            ok, fatal_error, outputs = self._execute_node(
                exec_id, node, ctx, last, ins, log_fn, published)
            if not ok:
                self.db.finish_execution(exec_id, "failed", fatal_error)
                return exec_id, "failed", fatal_error
            if outputs is not None:
                node_outputs[nid] = outputs

        self.db.finish_execution(exec_id, "passed", None)
        return exec_id, "passed", None

    def _run_subflow(self, name, environment, env_vars, seed_vars, stack,
                     log_fn, media):
        """Run another saved flow by name (used by ctx['run_flow']).

        Returns {execution_id, status, error, outputs} where `outputs` is the
        subflow's published output aliases. Guards against recursion.
        """
        name = str(name or "").strip()
        if not name:
            return {"execution_id": None, "status": "error",
                    "error": "subflow name is required", "outputs": {}}
        if name in stack:
            chain = " -> ".join(stack + [name])
            return {"execution_id": None, "status": "error",
                    "error": f"recursive subflow call: {chain}", "outputs": {}}
        flow = self.db.get_flow_by_name(name)
        if flow is None:
            return {"execution_id": None, "status": "error",
                    "error": f"subflow not found: {name!r}", "outputs": {}}
        collector = {}
        exec_id, status, error = self.execute(
            flow["id"], flow["name"], flow["graph"], environment=environment,
            env_vars=env_vars, seed_vars=seed_vars, out_collector=collector,
            call_stack=stack + [name], log=log_fn, media=media)
        return {"execution_id": exec_id, "status": status, "error": error,
                "outputs": collector}

    def _execute_node(self, exec_id, node, ctx, last, ins=None, log_fn=None,
                      published=None):
        """Run one node. Returns (ok, error, outputs).

        `last` is the outputs of this node's first connected parent and `ins`
        is the list of outputs of all connected parents (in order) — use it
        for join nodes that need every input, e.g. `ins[1]`. Records the step.
        A skipped node returns (True, None, None).
        """
        name = _name(node)
        ctx["last"] = last  # this node's view of the previous node's outputs
        ctx["ins"] = list(ins) if ins else []  # all parents' outputs, in order
        # node-scoped logger: ctx["log"]("hi", x) -> "<node name>: hi <x>"
        base_log = log_fn if callable(log_fn) else (lambda *_a, **_k: None)
        ctx["log"] = lambda *parts: base_log(
            f"{name}: " + " ".join(str(p) for p in parts))
        # media(path) -> served URL, or None when unavailable (e.g. headless)
        ctx["media"] = getattr(self, "_media", None)
        t0 = time.time()

        def record(status, error=None, inputs=None, outputs=None):
            self.db.add_step(
                exec_id, node.get("id"), name, node.get("type"), status,
                error, _json(inputs or {}), _json(outputs or {}), t0,
                time.time())

        # 1. pre: falsy -> skip  (accepts legacy 'condition' graphs)
        cond = (node.get("pre") or node.get("condition") or "").strip()
        if cond:
            try:
                if not safe_eval(cond, ctx):
                    record("skipped", f"pre is false: {cond}")
                    return True, None, None
            except Exception as e:
                err = f"pre error in '{name}': {type(e).__name__}: {e}"
                record("failed", err)
                return False, err, None

        cls = self.registry.get(node.get("type"))
        if cls is None:
            err = (f"unknown node type '{node.get('type')}' "
                   f"(is its file still in the nodes/ folder?)")
            record("failed", err)
            return False, err, None

        # 2. resolve inputs ({{ templates }})
        try:
            inputs = {}
            for pname, default in cls.inputs.items():
                raw = node.get("params", {}).get(pname, default)
                inputs[pname] = resolve_value(raw, ctx)
        except Exception as e:
            err = f"input error in '{name}': {type(e).__name__}: {e}"
            record("failed", err)
            return False, err, None

        # 3. run + class check hook + post expression
        try:
            instance = cls()
            outputs = instance.run(inputs, ctx)
            if outputs is None:
                outputs = {}
            if not isinstance(outputs, dict):
                outputs = {"value": outputs}
            instance.check(outputs, inputs, ctx)

            # post expression (accepts legacy 'assert' graphs)
            post_expr = (node.get("post") or node.get("assert") or "").strip()
            if post_expr:
                env_ctx = dict(ctx)
                env_ctx["last"] = outputs
                env_ctx[name] = outputs
                if not safe_eval(post_expr, env_ctx):
                    raise AssertionFailure(
                        f"post expression is falsy: {post_expr}")
        except Exception as e:
            tb = traceback.format_exc(limit=4)
            err = f"node '{name}' failed: {type(e).__name__}: {e}"
            record("failed", f"{err}\n{tb}",
                   inputs=inputs)
            return False, err, None

        ctx[name] = outputs
        # publish aliased outputs as flat context variables,
        # e.g. out_aliases {"value": "casenumber"} -> ctx["casenumber"]
        for oname, alias in (node.get("out_aliases") or {}).items():
            alias = str(alias).strip()
            if alias and alias != "last" and oname in outputs:
                ctx[alias] = outputs[oname]
                if published is not None:  # expose to a parent subflow caller
                    published[alias] = outputs[oname]
        record("passed", None, inputs=inputs, outputs=outputs)
        return True, None, outputs

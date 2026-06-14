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
    at missing nodes) are ignored.
    """
    nodes = {n["id"]: n for n in graph.get("nodes", [])}
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


def _first_parent_outputs(nid, parents, node_outputs):
    """`last` for a node = outputs of its first parent that produced any."""
    for pid in parents.get(nid, []):
        if pid in node_outputs:
            return node_outputs[pid]
    return {}


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
                env_vars=None, trigger_node=None, trigger_outputs=None):
        """Run a flow graph as a DAG. Returns (execution_id, status, error).

        `env_vars` (dict) are injected into the context before any node:
        available as `env['key']` and, for identifier-safe keys, directly as
        `key` in expressions / `ctx['key']` in node code.

        Listener runtime: pass `trigger_node` (the trigger's node dict) and
        `trigger_outputs`. The trigger's outputs are seeded into the context
        and only the subgraph reachable from it is executed.
        """
        exec_id = self.db.create_execution(flow_id, flow_name, environment)
        try:
            nodes, order, parents, children = build_dag(graph)
        except FlowValidationError as e:
            self.db.finish_execution(exec_id, "error", str(e))
            return exec_id, "error", str(e)

        ctx = {}
        if env_vars:
            ctx["env"] = dict(env_vars)
            for k, v in env_vars.items():
                if isinstance(k, str) and k not in ("last", "ctx", "env"):
                    ctx[k] = v

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
            last = _first_parent_outputs(nid, parents, node_outputs)
            ok, fatal_error, outputs = self._execute_node(
                exec_id, node, ctx, last)
            if not ok:
                self.db.finish_execution(exec_id, "failed", fatal_error)
                return exec_id, "failed", fatal_error
            if outputs is not None:
                node_outputs[nid] = outputs

        self.db.finish_execution(exec_id, "passed", None)
        return exec_id, "passed", None

    def _execute_node(self, exec_id, node, ctx, last):
        """Run one node. Returns (ok, error, outputs).

        `last` is the outputs of this node's first connected parent. Records
        the step. A skipped node returns (True, None, None).
        """
        name = _name(node)
        ctx["last"] = last  # this node's view of the previous node's outputs
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
        record("passed", None, inputs=inputs, outputs=outputs)
        return True, None, outputs

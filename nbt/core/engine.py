"""Flow validation and execution engine.

Execution model:
  * The chain starts at the single node with no incoming connection
    (validated) and follows output links linearly.
  * If a node's `condition` expression evaluates falsy, the node is SKIPPED
    and execution moves on.
  * A node executes by instantiating its class and calling run(); it fails if
    run() raises, if the class check() hook raises, or if the node's `assert`
    expression is falsy / raises.
  * If any node fails, the whole flow fails immediately. Otherwise it passes.

Expressions (condition / assert / {{ templates }} in string inputs) are
evaluated against the execution context:
  * `ctx`  - dict of {node name: outputs dict} for already-executed nodes
  * `last` - outputs of the most recently executed node
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


def build_chain(graph):
    """Validate the graph and return the ordered list of node dicts.

    Rules: exactly one start node (no incoming link), each node has at most
    one incoming and one outgoing link, no cycles, no disconnected nodes.
    """
    nodes = {n["id"]: n for n in graph.get("nodes", [])}
    links = graph.get("links", [])
    if not nodes:
        raise FlowValidationError("Flow has no nodes.")

    incoming = {nid: 0 for nid in nodes}
    outgoing = {}
    for link in links:
        src, dst = link[0], link[1]
        if src not in nodes or dst not in nodes:
            continue  # stale link
        if src in outgoing:
            raise FlowValidationError(
                f"Node '{_name(nodes[src])}' has more than one outgoing "
                "connection; flows must be a single chain.")
        outgoing[src] = dst
        incoming[dst] += 1
        if incoming[dst] > 1:
            raise FlowValidationError(
                f"Node '{_name(nodes[dst])}' has more than one incoming "
                "connection; flows must be a single chain.")

    starts = [nid for nid, c in incoming.items() if c == 0]
    if len(starts) != 1:
        names = ", ".join(_name(nodes[s]) for s in starts) or "none"
        raise FlowValidationError(
            f"Flow must have exactly one start node (a node with no previous "
            f"node). Found {len(starts)}: {names}.")

    chain, cur, seen = [], starts[0], set()
    while cur is not None:
        if cur in seen:
            raise FlowValidationError("Flow contains a cycle.")
        seen.add(cur)
        chain.append(nodes[cur])
        cur = outgoing.get(cur)

    if len(chain) != len(nodes):
        orphans = [_name(n) for nid, n in nodes.items() if nid not in seen]
        raise FlowValidationError(
            "Flow contains nodes not connected to the chain: "
            + ", ".join(orphans))
    return chain


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
                env_vars=None, trigger_outputs=None):
        """Run a flow graph. Returns (execution_id, status, error).

        `env_vars` (dict) are injected into the context before the first
        node: available as `env['key']` and, for identifier-safe keys,
        directly as `key` in expressions / `ctx['key']` in node code.

        `trigger_outputs` is used by the listener runtime: the start node is
        a trigger that already fired, so its outputs are seeded into the
        context (aliases included) and execution begins at the second node.
        """
        exec_id = self.db.create_execution(flow_id, flow_name, environment)
        try:
            chain = build_chain(graph)
        except FlowValidationError as e:
            self.db.finish_execution(exec_id, "error", str(e))
            return exec_id, "error", str(e)

        ctx = {}
        if env_vars:
            ctx["env"] = dict(env_vars)
            for k, v in env_vars.items():
                if isinstance(k, str) and k not in ("last", "ctx", "env"):
                    ctx[k] = v

        if trigger_outputs is not None:
            tnode = chain[0]
            tname = _name(tnode)
            outputs = (trigger_outputs if isinstance(trigger_outputs, dict)
                       else {"value": trigger_outputs})
            now = time.time()
            self.db.add_step(
                exec_id, tnode.get("id"), tname, tnode.get("type"), "passed",
                None, _json({}), _json(outputs), now, now)
            ctx[tname] = outputs
            ctx["last"] = outputs
            for oname, alias in (tnode.get("out_aliases") or {}).items():
                alias = str(alias).strip()
                if alias and alias != "last" and oname in outputs:
                    ctx[alias] = outputs[oname]
            chain = chain[1:]
        else:
            cls0 = self.registry.get(chain[0].get("type"))
            if cls0 is not None and getattr(cls0, "is_trigger", False):
                err = (f"start node '{_name(chain[0])}' is a trigger node - "
                       "use Listen instead of Run to arm it")
                self.db.finish_execution(exec_id, "error", err)
                return exec_id, "error", err

        for node in chain:
            ok, fatal_error = self._execute_node(exec_id, node, ctx)
            if not ok:
                self.db.finish_execution(exec_id, "failed", fatal_error)
                return exec_id, "failed", fatal_error

        self.db.finish_execution(exec_id, "passed", None)
        return exec_id, "passed", None

    def _execute_node(self, exec_id, node, ctx):
        """Returns (ok, error). Records the step. Skipped counts as ok."""
        name = _name(node)
        t0 = time.time()

        def record(status, error=None, inputs=None, outputs=None):
            self.db.add_step(
                exec_id, node.get("id"), name, node.get("type"), status,
                error, _json(inputs or {}), _json(outputs or {}), t0,
                time.time())

        # 1. condition: falsy -> skip
        cond = (node.get("condition") or "").strip()
        if cond:
            try:
                if not safe_eval(cond, ctx):
                    record("skipped", f"condition is false: {cond}")
                    return True, None
            except Exception as e:
                err = f"condition error in '{name}': {type(e).__name__}: {e}"
                record("failed", err)
                return False, err

        cls = self.registry.get(node.get("type"))
        if cls is None:
            err = (f"unknown node type '{node.get('type')}' "
                   f"(is its file still in the nodes/ folder?)")
            record("failed", err)
            return False, err

        # 2. resolve inputs ({{ templates }})
        try:
            inputs = {}
            for pname, default in cls.inputs.items():
                raw = node.get("params", {}).get(pname, default)
                inputs[pname] = resolve_value(raw, ctx)
        except Exception as e:
            err = f"input error in '{name}': {type(e).__name__}: {e}"
            record("failed", err)
            return False, err

        # 3. run + class check hook + assert expression
        try:
            instance = cls()
            outputs = instance.run(inputs, ctx)
            if outputs is None:
                outputs = {}
            if not isinstance(outputs, dict):
                outputs = {"value": outputs}
            instance.check(outputs, inputs, ctx)

            assert_expr = (node.get("assert") or "").strip()
            if assert_expr:
                env_ctx = dict(ctx)
                env_ctx["last"] = outputs
                env_ctx[name] = outputs
                if not safe_eval(assert_expr, env_ctx):
                    raise AssertionFailure(
                        f"assert expression is falsy: {assert_expr}")
        except Exception as e:
            tb = traceback.format_exc(limit=4)
            err = f"node '{name}' failed: {type(e).__name__}: {e}"
            record("failed", f"{err}\n{tb}",
                   inputs=inputs)
            return False, err

        ctx[name] = outputs
        ctx["last"] = outputs
        # publish aliased outputs as flat context variables,
        # e.g. out_aliases {"value": "casenumber"} -> ctx["casenumber"]
        for oname, alias in (node.get("out_aliases") or {}).items():
            alias = str(alias).strip()
            if alias and alias != "last" and oname in outputs:
                ctx[alias] = outputs[oname]
        record("passed", None, inputs=inputs, outputs=outputs)
        return True, None

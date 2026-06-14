"""Headless tests for the engine, registry and database (no GUI needed).

Run: python tests/test_engine.py
"""

import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from nbt.core.engine import Engine, build_dag, FlowValidationError  # noqa
from nbt.core.listener import FlowListener                            # noqa
from nbt.core.registry import NodeRegistry                            # noqa
from nbt.db.database import Database                                  # noqa

PASS = FAIL = 0


def check(name, cond, info=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok    {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}  {info}")


def node(nid, ntype, name=None, params=None, pre="", post=""):
    return {"id": nid, "type": ntype, "name": name or nid,
            "params": params or {}, "pre": pre,
            "post": post, "pos": [0, 0]}


def main():
    registry = NodeRegistry(ROOT / "nodes").load()
    check("registry loads sample nodes", len(registry.types) >= 5,
          str(registry.types.keys()))
    check("no registry load errors", not registry.errors,
          str(registry.errors))

    tmp = tempfile.mkdtemp()
    db = Database(Path(tmp) / "test.db")
    engine = Engine(registry, db)

    # ---- flow CRUD ----
    fid = db.create_flow("t1")
    check("create/list flow", db.list_flows()[0]["name"] == "t1")
    db.rename_flow(fid, "t1b")
    check("rename flow", db.get_flow(fid)["name"] == "t1b")
    fid2 = db.duplicate_flow(fid, "t1c")
    check("duplicate flow", db.get_flow(fid2) is not None)
    db.delete_flow(fid2)
    check("delete flow", db.get_flow(fid2) is None)

    # ---- DAG validation ----
    def expect_invalid(name, graph):
        try:
            build_dag(graph)
            check(name, False, "no error raised")
        except FlowValidationError:
            check(name, True)

    def expect_valid(name, graph):
        try:
            build_dag(graph)
            check(name, True)
        except FlowValidationError as e:
            check(name, False, str(e))

    expect_invalid("empty flow rejected", {"nodes": [], "links": []})
    expect_invalid("cycle rejected", {
        "nodes": [node("a", "set_value"), node("b", "set_value")],
        "links": [["a", "b"], ["b", "a"]]})
    # DAG model: these were rejected by the old linear engine, now allowed
    expect_valid("multiple roots allowed", {
        "nodes": [node("a", "set_value"), node("b", "set_value"),
                  node("c", "set_value")],
        "links": [["a", "c"]]})
    expect_valid("branching allowed", {
        "nodes": [node("a", "set_value"), node("b", "set_value"),
                  node("c", "set_value")],
        "links": [["a", "b"], ["a", "c"]]})
    expect_valid("join (multiple parents) allowed", {
        "nodes": [node("a", "set_value"), node("b", "set_value"),
                  node("c", "set_value")],
        "links": [["a", "c"], ["b", "c"]]})
    expect_valid("disconnected subgraphs allowed", {
        "nodes": [node("a", "set_value"), node("b", "set_value")],
        "links": []})

    _nodes, order, _parents, _children = build_dag({
        "nodes": [node("b", "set_value"), node("a", "set_value")],
        "links": [["a", "b"]]})
    check("topological order from root", order == ["a", "b"])

    # ---- passing flow with templating + condition skip + assert expr ----
    graph = {
        "nodes": [
            node("n1", "set_value", "greeting", {"value": "hello"}),
            node("n2", "python_eval", "upper",
                 {"expression": "greeting['value'].upper()"},
                 post="last['value'] == 'HELLO'"),
            node("n3", "delay", "wait", {"seconds": 5.0}, pre="1 == 2"),
            node("n4", "assert_equals", "verify",
                 {"actual": "{{ upper['value'] }}", "expected": "HELLO"}),
        ],
        "links": [["n1", "n2"], ["n2", "n3"], ["n3", "n4"]],
    }
    eid, status, err = engine.execute(fid, "t1b", graph)
    check("happy path passes", status == "passed", str(err))
    steps = db.get_steps(eid)
    check("4 steps recorded", len(steps) == 4)
    check("condition skips node",
          [s["status"] for s in steps] ==
          ["passed", "passed", "skipped", "passed"], str(steps))
    check("skipped delay did not sleep 5s",
          steps[2]["finished_at"] - steps[0]["started_at"] < 2)

    # ---- failing assert expression fails whole flow ----
    g2 = {
        "nodes": [
            node("n1", "set_value", "v", {"value": "x"}),
            node("n2", "python_eval", "calc", {"expression": "2 + 2"},
                 post="last['value'] == 5"),
            node("n3", "set_value", "never", {"value": "y"}),
        ],
        "links": [["n1", "n2"], ["n2", "n3"]],
    }
    eid, status, err = engine.execute(fid, "t1b", g2)
    steps = db.get_steps(eid)
    check("falsy assert fails flow", status == "failed", str(err))
    check("execution stops at failure", len(steps) == 2, str(len(steps)))
    check("step marked failed", steps[1]["status"] == "failed")

    # ---- run() raising fails the flow (AssertEquals check hook) ----
    g3 = {
        "nodes": [
            node("n1", "set_value", "v", {"value": "a"}),
            node("n2", "assert_equals", "cmp",
                 {"actual": "{{ v['value'] }}", "expected": "b"}),
        ],
        "links": [["n1", "n2"]],
    }
    _, status, err = engine.execute(fid, "t1b", g3)
    check("check() hook failure fails flow", status == "failed", str(err))
    check("error message useful", "expected 'b'" in (err or ""), str(err))

    # ---- bad condition expression fails ----
    g4 = {"nodes": [node("n1", "set_value", "v", {"value": "a"},
                         pre="nope['x']")], "links": []}
    _, status, err = engine.execute(fid, "t1b", g4)
    check("broken condition fails flow", status == "failed", str(err))

    # ---- unknown node type fails (not crashes) ----
    g5 = {"nodes": [node("n1", "does_not_exist")], "links": []}
    _, status, err = engine.execute(fid, "t1b", g5)
    check("unknown node type fails gracefully", status == "failed", str(err))

    # ---- structural error recorded as 'error' execution ----
    _, status, err = engine.execute(fid, "t1b", {"nodes": [], "links": []})
    check("invalid graph -> error status", status == "error", str(err))

    # ---- output aliases publish flat context variables ----
    n1 = node("n1", "set_value", "create_case", {"value": "0001"})
    n1["out_aliases"] = {"value": "casenumber"}
    g6 = {
        "nodes": [
            n1,
            node("n2", "python_eval", "use",
                 {"expression": "casenumber"},
                 post="last['value'] == '0001'"),
            node("n3", "assert_equals", "tmpl",
                 {"actual": "{{ casenumber }}", "expected": "0001"}),
        ],
        "links": [["n1", "n2"], ["n2", "n3"]],
    }
    eid, status, err = engine.execute(fid, "t1b", g6)
    check("output alias usable as bare var", status == "passed", str(err))

    # ---- environments: CRUD + variable injection ----
    envid = db.create_environment(
        "staging", {"base_url": "https://stg.example.com", "token": "abc"})
    check("env create/list",
          db.list_environments()[0]["name"] == "staging")
    check("env get by name",
          db.get_environment_by_name("staging")["vars"]["token"] == "abc")
    g7 = {
        "nodes": [
            node("n1", "set_value", "sv", {"value": "{{ base_url }}/login"},
                 post="last['value'] == 'https://stg.example.com/login'"),
            node("n2", "python_eval", "pe", {"expression": "env['token']"},
                 post="last['value'] == 'abc'"),
        ],
        "links": [["n1", "n2"]],
    }
    eid, status, err = engine.execute(
        fid, "t1b", g7, environment="staging",
        env_vars=db.get_environment(envid)["vars"])
    check("env vars injected into ctx", status == "passed", str(err))
    check("execution records env name",
          db.get_execution(eid)["environment"] == "staging")
    db.update_environment(envid, vars_dict={"base_url": "x"})
    check("env update",
          db.get_environment(envid)["vars"] == {"base_url": "x"})
    db.delete_environment(envid)
    check("env delete", db.get_environment(envid) is None)

    # ---- trigger nodes + listener ----
    import time as _time
    check("trigger nodes discovered",
          getattr(registry.get("interval_trigger"), "is_trigger", False))

    trig = node("t1", "interval_trigger", "every",
                {"seconds": 0.1, "emit_immediately": True})
    trig["out_aliases"] = {"tick": "tick"}
    g8 = {
        "nodes": [
            trig,
            node("n2", "python_eval", "use", {"expression": "tick"},
                 post="last['value'] >= 1"),
        ],
        "links": [["t1", "n2"]],
    }
    # pressing Run on a trigger flow must be rejected
    _, status, err = engine.execute(fid, "t1b", g8)
    check("Run on trigger flow -> error", status == "error"
          and "Listen" in (err or ""), str(err))

    db.clear_executions()
    flow = {"id": fid, "name": "t1b", "graph": g8}
    lst = FlowListener(engine, flow)
    lst.start()
    _time.sleep(0.45)
    lst.stop()
    runs_at_stop = lst.runs
    check("listener fired multiple runs", runs_at_stop >= 2,
          f"runs={lst.runs}")
    _time.sleep(0.25)
    check("stop() really stops the trigger", lst.runs == runs_at_stop)
    execs = db.list_executions()
    check("triggered runs recorded + passed",
          len(execs) == runs_at_stop
          and all(e["status"] == "passed" for e in execs),
          str([(e["status"], e["error"]) for e in execs]))
    steps = db.get_steps(execs[0]["id"])
    check("trigger recorded as first step",
          steps[0]["node_type"] == "interval_trigger"
          and steps[0]["status"] == "passed", str(steps))

    # condition on the trigger filters events (only even ticks run)
    db.clear_executions()
    trig2 = dict(trig)
    trig2["pre"] = "last['tick'] % 2 == 0"
    g9 = {"nodes": [trig2, g8["nodes"][1]], "links": [["t1", "n2"]]}
    lst2 = FlowListener(engine, {"id": fid, "name": "t1b", "graph": g9})
    lst2.start()
    _time.sleep(0.55)
    lst2.stop()
    check("condition filters trigger events",
          lst2.filtered > 0 and lst2.runs > 0
          and lst2.events == lst2.runs + lst2.filtered,
          f"events={lst2.events} runs={lst2.runs} filtered={lst2.filtered}")

    # listening on a non-trigger flow is rejected
    lst3 = FlowListener(engine, {"id": fid, "name": "t1b", "graph": graph})
    try:
        lst3.start()
        check("listen on non-trigger flow rejected", False, "no error")
    except FlowValidationError:
        check("listen on non-trigger flow rejected", True)

    # a standalone trigger (no outgoing connection) still arms and records
    db.clear_executions()
    g_standalone = {"nodes": [dict(trig)], "links": []}
    lst4 = FlowListener(engine, {"id": fid, "name": "t1b",
                                 "graph": g_standalone})
    lst4.start()
    _time.sleep(0.35)
    lst4.stop()
    check("standalone trigger (no connection) runs", lst4.runs >= 2,
          f"runs={lst4.runs}")
    execs = db.list_executions()
    check("standalone trigger records trigger-only step",
          len(execs) >= 1
          and len(db.get_steps(execs[0]["id"])) == 1
          and all(e["status"] == "passed" for e in execs),
          str([(e["status"], e["error"]) for e in execs]))

    # ---- executions are persisted ----
    check("executions listed", len(db.list_executions()) >= 1)
    db.clear_executions()
    check("clear executions", len(db.list_executions()) == 0)

    db.close()
    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())

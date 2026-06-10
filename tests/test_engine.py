"""Headless tests for the engine, registry and database (no GUI needed).

Run: python tests/test_engine.py
"""

import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from nbt.core.engine import Engine, build_chain, FlowValidationError  # noqa
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


def node(nid, ntype, name=None, params=None, condition="", assert_=""):
    return {"id": nid, "type": ntype, "name": name or nid,
            "params": params or {}, "condition": condition,
            "assert": assert_, "pos": [0, 0]}


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

    # ---- validation ----
    def expect_invalid(name, graph):
        try:
            build_chain(graph)
            check(name, False, "no error raised")
        except FlowValidationError:
            check(name, True)

    expect_invalid("empty flow rejected", {"nodes": [], "links": []})
    expect_invalid("two start nodes rejected", {
        "nodes": [node("a", "set_value"), node("b", "set_value"),
                  node("c", "set_value")],
        "links": [["a", "c"]]})
    expect_invalid("branching rejected", {
        "nodes": [node("a", "set_value"), node("b", "set_value"),
                  node("c", "set_value")],
        "links": [["a", "b"], ["a", "c"]]})
    expect_invalid("cycle rejected", {
        "nodes": [node("a", "set_value"), node("b", "set_value")],
        "links": [["a", "b"], ["b", "a"]]})

    chain = build_chain({
        "nodes": [node("b", "set_value"), node("a", "set_value")],
        "links": [["a", "b"]]})
    check("chain ordered from start", [n["id"] for n in chain] == ["a", "b"])

    # ---- passing flow with templating + condition skip + assert expr ----
    graph = {
        "nodes": [
            node("n1", "set_value", "greeting", {"value": "hello"}),
            node("n2", "python_eval", "upper",
                 {"expression": "greeting['value'].upper()"},
                 assert_="last['value'] == 'HELLO'"),
            node("n3", "delay", "wait", {"seconds": 5.0}, condition="1 == 2"),
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
                 assert_="last['value'] == 5"),
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
                         condition="nope['x']")], "links": []}
    _, status, err = engine.execute(fid, "t1b", g4)
    check("broken condition fails flow", status == "failed", str(err))

    # ---- unknown node type fails (not crashes) ----
    g5 = {"nodes": [node("n1", "does_not_exist")], "links": []}
    _, status, err = engine.execute(fid, "t1b", g5)
    check("unknown node type fails gracefully", status == "failed", str(err))

    # ---- structural error recorded as 'error' execution ----
    _, status, err = engine.execute(fid, "t1b", {"nodes": [], "links": []})
    check("invalid graph -> error status", status == "error", str(err))

    # ---- executions are persisted ----
    check("executions listed", len(db.list_executions()) >= 5)
    db.clear_executions()
    check("clear executions", len(db.list_executions()) == 0)

    db.close()
    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())

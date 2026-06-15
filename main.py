"""NBT - Node Based Tester. Entry point.

Web UI:    python main.py [--port 8080]      then open http://localhost:8080
Headless:  python main.py --run "Flow Name" [--env staging]   (exit 0 = pass)
           python main.py --list
"""

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from nbt.core.registry import NodeRegistry          # noqa: E402
from nbt.core.engine import Engine                  # noqa: E402
from nbt.db.database import Database                # noqa: E402

DEMO_GRAPH = {
    "nodes": [
        {"id": "n1", "type": "set_value", "name": "greeting",
         "params": {"value": "hello"}, "pre": "", "post": "",
         "out_aliases": {"value": "greeting"}, "pos": [40, 120]},
        {"id": "n2", "type": "python_eval", "name": "upper",
         "params": {"expression": "greeting.upper()"},
         "pre": "", "post": "last['value'] == 'HELLO'",
         "out_aliases": {"value": "upper"}, "pos": [330, 120]},
        {"id": "n3", "type": "delay", "name": "wait",
         "params": {"seconds": 2.0}, "pre": "1 == 2",  # skipped
         "post": "", "out_aliases": {}, "pos": [620, 120]},
        {"id": "n4", "type": "assert_equals", "name": "verify",
         "params": {"actual": "{{ upper }}", "expected": "HELLO"},
         "pre": "", "post": "", "out_aliases": {},
         "pos": [910, 120]},
    ],
    "links": [["n1", "n2"], ["n2", "n3"], ["n3", "n4"]],
}


def bootstrap(db_path=None):
    db = Database(db_path or ROOT / "data" / "nbt.db")
    registry = NodeRegistry(ROOT / "nodes").load()
    if not db.list_flows():
        db.create_flow("Demo Flow", DEMO_GRAPH)
    return db, registry


def main():
    ap = argparse.ArgumentParser(description="NBT - Node Based Tester")
    ap.add_argument("--db", help="path to sqlite database file")
    ap.add_argument("--port", type=int, default=8080,
                    help="web UI port (default 8080)")
    ap.add_argument("--run", metavar="FLOW", help="run a flow headless by name")
    ap.add_argument("--env", metavar="ENV",
                    help="environment name to run with (headless)")
    ap.add_argument("--list", action="store_true", help="list flows and exit")
    args = ap.parse_args()

    db, registry = bootstrap(args.db)

    if args.list:
        for f in db.list_flows():
            print(f"{f['id']}  {f['name']}")
        return 0

    if args.run:
        flow = db.get_flow_by_name(args.run)
        if flow is None:
            print(f"flow not found: {args.run!r}", file=sys.stderr)
            return 2
        env_name, env_vars = None, None
        if args.env:
            env = db.get_environment_by_name(args.env)
            if env is None:
                print(f"environment not found: {args.env!r}", file=sys.stderr)
                return 2
            env_name, env_vars = env["name"], env["vars"]
        engine = Engine(registry, db)
        exec_id, status, error = engine.execute(
            flow["id"], flow["name"], flow["graph"],
            environment=env_name, env_vars=env_vars,
            log=lambda m: print("    " + m))
        print(f"execution {exec_id}: {status.upper()}")
        for st in db.get_steps(exec_id):
            line = f"  [{st['status']:>7}] {st['node_name']} ({st['node_type']})"
            if st["status"] == "passed":
                line += f"  outputs={st['outputs']}"
            print(line)
            if st["error"]:
                print("           " + st["error"].splitlines()[0])
        if error:
            print(f"error: {error}", file=sys.stderr)
        return 0 if status == "passed" else 1

    # No CLI action: the UI now lives in the React app served by the API.
    print("NBT CLI. The web UI is served by the API server:\n"
          "    python api_server.py        # http://localhost:8000\n"
          "Headless options: --run \"Flow Name\" [--env NAME] | --list",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    _code = main()
    if _code is not None:
        sys.exit(_code)

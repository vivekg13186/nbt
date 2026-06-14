# NBT — Node Based Tester

A web-based node editor (React + LiteGraph.js, FastAPI backend) for building, saving and running test flows, backed by SQLite. Intended for internal, single-user use — there is no authentication, expression fields evaluate Python on the server, and the UI exposes an interactive server shell, so don't expose it beyond a trusted network.

## Run

```bash
pip install -r requirements.txt
cd webui && npm install && npm run build && cd ..   # build the web UI once
python api_server.py                # http://localhost:8000
python api_server.py --port 9000    # different port
```

Headless / CLI (no server):

```bash
python main.py --run "Demo Flow"                 # exit code 0 = passed
python main.py --run "Demo Flow" --env staging   # run with an environment
python main.py --list                            # list flows
python tests/test_engine.py                      # test suite
```

A `Demo Flow` is seeded on first launch. The database lives at `data/nbt.db`.

For frontend development, run the API and the Vite dev server (with hot reload) as two processes instead:

```bash
python api_server.py                     # API -> http://localhost:8000
cd webui && npm run dev                   # SPA -> http://localhost:5173 (proxies /api)
```

See `webui/README.md` for UI details.

## Using the editor

The tab bar holds open workflows (right-click a tab for Save / Rename / Duplicate / Close / Delete); the toolbar has the active workflow name, Add node, the environment picker, and Save / Listen / Run. The left rail switches between Workflows, Nodes, Packages, Environments, Listeners and Executions. The **Packages** view installs groups of custom nodes from a git URL or a `.nbtpack`/`.zip` bundle (see `docs/CUSTOM_NODES.md`). To add a node, use the Nodes palette, the toolbar's Add node, or right-click the canvas. Drag from a node's `out` pin to another node's `in` pin to connect; the canvas pans and zooms with the mouse. A toggleable shell sits at the bottom. The Executions page lists runs; click one for step inputs/outputs/error detail.

Each node has its declared **inputs**, a **pre** expression (falsy → node is skipped) and a **post** expression (falsy → node fails). Edit a node's name via its title (right-click node → Title). Each declared output gets an alias box (`→ value`): type a variable name (e.g. `casenumber`) and that output is published flat into the context — later nodes can use `casenumber` / `{{ casenumber }}` / `ctx['casenumber']`. Use `last` for the first connected parent's outputs.

## Execution rules (DAG)

A flow is a directed acyclic graph: nodes may have multiple inputs and outputs, branches and joins are allowed, and a graph may contain several disconnected subgraphs — the only structural rule is no cycles. Nodes execute in topological order; a node's `last` is its first connected parent's outputs. A node fails if `run()` raises, if the class `check()` hook raises, or if its post expression is falsy. Any failure fails the whole flow immediately; otherwise it passes. Every run and every step is recorded in SQLite.

## Trigger (listener) flows

A flow can contain a **trigger node** (marked ⚡) — e.g. *Interval Trigger* (emit every N seconds) or *File Watch Trigger* (emit when a file changes). A trigger need not be connected to anything; it can stand alone or be the root of a subgraph. Trigger flows aren't Run; press **Listen** to arm the trigger. Every emitted event executes the subgraph reachable from the trigger with the trigger's outputs available downstream, and each event becomes its own recorded execution. The trigger's *pre* field is an event filter — falsy events are ignored without creating an execution.

Multiple flows can listen at once (one listener per flow, each on a snapshot of its graph taken when armed). The **Listen** button toggles the *current* flow; **Listeners: N** opens a manager with live stats (events / runs / filtered / busy-skips / last result) and per-listener Stop buttons, plus Stop All. Listeners live in the server process, so they keep firing with no browser tab open. Events arriving while that flow's previous run is still in progress are dropped and counted.

## Environments

Environments are named sets of variables (e.g. `staging`, `prod`) managed in the **Environments** view — variables are a JSON object like `{"base_url": "https://stg.example.com", "token": "abc"}` edited in the JSON editor. Pick the active environment in the toolbar dropdown before running or listening; its variables are injected into the context, usable as `{{ base_url }}` in inputs, `base_url` in pre/post expressions, `env['token']` or `ctx['token']` anywhere. Each execution records which environment it ran with.

## Expressions and templating

The `pre` / `post` fields and `{{ ... }}` templates inside string inputs are Python expressions evaluated against the context: `last` is the previous node's outputs, output aliases and environment variables are available as plain names, and `ctx` is the whole dict. Example: input `{{ upper }}`, post `last['status'] == 200`.

## Custom nodes

Drop a `.py` file anywhere under `nodes/` (scanned recursively at server start). Group nodes into sub-folders — e.g. `nodes/pg/insert.py` — and the sub-folder name becomes the node's default palette category:

```python
from nbt.core.node_base import BaseNode

class MyNode(BaseNode):
    type_name = "my_node"            # unique key
    label = "My Node"
    category = "Custom"
    inputs = {"url": "", "retries": 3, "verbose": False}
    outputs = ["result"]

    def run(self, inputs, ctx):
        return {"result": inputs["url"].upper()}   # raise to fail

    def check(self, outputs, inputs, ctx):
        assert outputs["result"], "empty result"   # optional assert hook
```

Input widget types come from the defaults (bool → toggle, int/float → number, else text). Files and folders starting with `_` or `.` are ignored (so `nodes/pg/_helpers.py` can hold shared code). A broken node file never crashes the app — it's reported (with its sub-path) under *Load errors* in the palette. For listener-style nodes subclass `TriggerNode` — see `docs/CUSTOM_NODES.md` for the full guide.

Bundled nodes: Set Value, Python Eval, HTTP Request, Delay, Assert Equals, Interval Trigger ⚡, File Watch Trigger ⚡.

# NBT — Node Based Tester

A web-based node editor (NiceGUI + LiteGraph.js) for building, saving and running test flows, backed by SQLite. Intended for internal, single-user use — there is no authentication, and expression fields evaluate Python on the server, so don't expose it beyond a trusted network.

## Run

```bash
pip install -r requirements.txt
python main.py                      # web UI -> http://localhost:8080
python main.py --port 9000          # different port
python main.py --run "Demo Flow"    # headless run, exit code 0 = passed
python main.py --run "Demo Flow" --env staging   # run with an environment
python main.py --list               # list flows
python tests/test_engine.py         # test suite
```

A `Demo Flow` is seeded on first launch. The database lives at `data/nbt.db`. LiteGraph is vendored in `nbt/web/static/` (MIT license), so no internet access or CDN is needed.

## Using the editor

The header holds the flow selector and CRUD buttons (New / Rename / Dup / Del), the environment picker, and Save / Run / Listen. To add a node, right-click the canvas and pick from the menu (or double-click for the search box). Drag from a node's `out` pin to another node's `in` pin to connect; the canvas pans and zooms natively (mouse wheel). The executions table below the canvas is sortable; click a run to see its steps, click a step for inputs/outputs/error detail.

Each node has its declared **inputs**, a **condition** expression (falsy → node is skipped) and an **assert** expression (falsy → node fails). Each declared output gets an alias box (`→ value`): type a variable name (e.g. `casenumber`) and that output is published flat into the context — later nodes can use `casenumber` / `{{ casenumber }}` / `ctx['casenumber']`. Use `last` for the previous node's outputs.

## Execution rules

Execution starts at the single node with no previous node (validated: exactly one start, single chain, no cycles, no orphans) and proceeds link by link. A node fails if `run()` raises, if the class `check()` hook raises, or if its assert expression is falsy. Any failure fails the whole flow immediately; otherwise it passes. Every run and every step is recorded in SQLite.

## Trigger (listener) flows

A flow can start with a **trigger node** (marked ⚡) instead of a regular node — e.g. *Interval Trigger* (emit every N seconds) or *File Watch Trigger* (emit when a file changes). Trigger flows aren't Run; press **Listen** to arm them. Every emitted event executes the rest of the chain with the trigger's outputs available downstream, and each event becomes its own recorded execution. The trigger's *condition* field is an event filter — falsy events are ignored without creating an execution.

Multiple flows can listen at once (one listener per flow, each on a snapshot of its graph taken when armed). The **Listen** button toggles the *current* flow; **Listeners: N** opens a manager with live stats (events / runs / filtered / busy-skips / last result) and per-listener Stop buttons, plus Stop All. Listeners live in the server process, so they keep firing with no browser tab open. Events arriving while that flow's previous run is still in progress are dropped and counted.

## Environments

Environments are named sets of variables (e.g. `staging`, `prod`) managed via the **Envs** button — variables are a JSON object like `{"base_url": "https://stg.example.com", "token": "abc"}`. Pick the active environment in the `Env` dropdown before running or listening; its variables are injected into the context, usable as `{{ base_url }}` in inputs, `base_url` in condition/assert expressions, `env['token']` or `ctx['token']` anywhere. Each execution records which environment it ran with.

## Expressions and templating

Conditions, asserts and `{{ ... }}` templates inside string inputs are Python expressions evaluated against the context: `last` is the previous node's outputs, output aliases and environment variables are available as plain names, and `ctx` is the whole dict. Example: input `{{ upper }}`, assert `last['status'] == 200`.

## Custom nodes

Drop a `.py` file in `nodes/` (auto-discovered at server start):

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

Input widget types come from the defaults (bool → toggle, int/float → number, else text). A broken node file never crashes the app — it's reported under *Load errors* in the palette. For listener-style nodes subclass `TriggerNode` — see `docs/CUSTOM_NODES.md` for the full guide.

Bundled nodes: Set Value, Python Eval, HTTP Request, Delay, Assert Equals, Interval Trigger ⚡, File Watch Trigger ⚡.

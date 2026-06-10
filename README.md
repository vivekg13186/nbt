# NBT — Node Based Tester

A DearPyGui node editor for building, saving and running test flows backed by SQLite.

## Run

```bash
pip install -r requirements.txt
python main.py                      # GUI
python main.py --run "Demo Flow"    # headless run, exit code 0 = passed
python main.py --list               # list flows
python tests/test_engine.py         # test suite (25 checks)
```

A `Demo Flow` is seeded on first launch. The database lives at `data/nbt.db`.

## Using the editor

The left panel lists flows (New / Rename / Duplicate / Delete) and the node palette — click a node type to add it. Drag from a node's `out` pin to another node's `in` pin to connect (links are kept linear automatically; ctrl-click a link to remove it). Use **Save** to persist and **Run** to execute. The bottom panel shows all executions; click a run to see its steps, click a step to see inputs/outputs/error.

Each node has a **name** (its key in the context), its declared **inputs**, a **condition** expression (falsy → node is skipped) and an **assert** expression (falsy → node fails).

## Execution rules

Execution starts at the single node with no previous node (validated: exactly one start, single chain, no cycles, no orphans) and proceeds link by link. A node fails if `run()` raises, if the class `check()` hook raises, or if its assert expression is falsy. Any failure fails the whole flow immediately; otherwise it passes. Every run and every step is recorded in SQLite.

## Expressions and templating

Conditions, asserts and `{{ ... }}` templates inside string inputs are Python expressions evaluated against the context: `last` is the previous node's outputs, each executed node's outputs are available by node name (`upper['value']`), and `ctx` is the whole dict. Example: input `{{ upper['value'] }}`, assert `last['status'] == 200`.

## Custom nodes

Drop a `.py` file in `nodes/` (auto-discovered at startup, or click *Reload nodes/*):

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

Input widget types come from the defaults (bool → checkbox, int/float → number, else text). A broken node file never crashes the app — it's reported in the palette's load errors.

Bundled nodes: Set Value, Python Eval, HTTP Request, Delay, Assert Equals.

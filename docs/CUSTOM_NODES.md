# Writing Custom Nodes

NBT discovers nodes automatically: any `.py` file in the `nodes/` folder containing a subclass of `BaseNode` is loaded at startup (or via *Reload nodes/* in the app). No registration code is needed — drop the file in and the node appears in the palette.

## Minimal example

```python
# nodes/string_length.py
from nbt.core.node_base import BaseNode

class StringLength(BaseNode):
    type_name = "string_length"     # unique key, stored in saved flows
    label = "String Length"         # shown on the node in the editor
    category = "Strings"            # groups the palette / Add Node menu
    inputs = {"text": ""}           # input name -> default value
    outputs = ["length"]            # documents what run() returns

    def run(self, inputs, ctx):
        return {"length": len(inputs["text"])}
```

## Class attributes

| Attribute | Required | Purpose |
|---|---|---|
| `type_name` | yes | Unique identifier. Saved flows reference nodes by this key, so renaming it breaks existing flows that use the node. Must not be `"base"` or empty. |
| `label` | yes | Display name in the editor and palette. Safe to change anytime. |
| `category` | no | Palette grouping. Defaults to `"General"`, or to the node's sub-folder name (see "Grouping nodes" below). |
| `inputs` | no | Dict of `name -> default value`. Each entry becomes an editable field on the node. |
| `outputs` | no | List of output key names. Purely documentation — helps users of your node know what to reference. |

### How input defaults map to widgets

The *type of the default value* decides the widget rendered on the node:

| Default type | Widget |
|---|---|
| `bool` (`False`) | checkbox |
| `int` (`3`) | integer box |
| `float` (`1.5`) | float box |
| anything else (`""`) | text box (supports `{{ }}` templating) |

So `inputs = {"url": "", "retries": 3, "strict": False}` renders a text field, an int spinner and a checkbox.

## Methods

### `run(self, inputs, ctx) -> dict`

The node's work happens here.

- `inputs` — the node's input values, already resolved: numbers/bools come typed, and any `{{ expression }}` templates in string inputs have been evaluated.
- `ctx` — the execution context so far: `{node_name: outputs_dict}` for every previously executed node, plus `ctx["last"]` (outputs of the previous node).
- `ctx["log"]` — call it to print a message to the **Log** tab (and the CLI on headless runs), e.g. `ctx["log"]("fetched", len(rows), "rows")`. The line is prefixed with the node name. (A plain `print()` goes to the server console instead, not the UI.) The same `log(...)` is also callable inside `pre` / `post` expressions and Python Eval nodes.
- Return a dict of outputs. Returning `None` becomes `{}`; returning a non-dict is wrapped as `{"value": ...}`.
- **Raise any exception to fail the node** — and with it, the whole flow. Use `NodeError` for clean messages:

```python
from nbt.core.node_base import NodeError

def run(self, inputs, ctx):
    if not inputs["url"].startswith("http"):
        raise NodeError(f"invalid url: {inputs['url']!r}")
    ...
```

### `check(self, outputs, inputs, ctx) -> None` (optional)

The class-level assert hook, called right after `run()`. Raise (e.g. `AssertionFailure` or a plain `assert`) to fail the node. Use it for validations that should *always* apply to this node type:

```python
from nbt.core.node_base import AssertionFailure

def check(self, outputs, inputs, ctx):
    if outputs["status"] >= 500:
        raise AssertionFailure(f"server error: {outputs['status']}")
```

## What happens at execution time

For each node in the chain, in order:

1. **Condition** (set per-node in the editor) is evaluated. Falsy → node is **skipped**, flow continues. An error in the expression fails the flow.
2. **Inputs are resolved** — `{{ expression }}` templates in string inputs are evaluated against `ctx`. If the *entire* value is one template (`{{ upper['value'] }}`), the raw object is passed (not a string), so dicts/numbers flow between nodes intact.
3. **`run()`** executes. Raising fails the node.
4. **`check()`** hook runs. Raising fails the node.
5. **Assert expression** (set per-node in the editor) is evaluated with `last` bound to this node's own outputs. Falsy or raising fails the node.
6. Outputs are stored: `ctx[node_name] = outputs` and `ctx["last"] = outputs`.

Any failure stops the flow immediately and the execution is recorded as FAILED with the step's error, inputs and traceback in the Executions panel.

## Expressions cheat sheet

The `pre` / `post` fields and templates are Python expressions with safe builtins (`len`, `str`, `int`, `min`, `max`, `sorted`, ...). Available names:

- `last` — outputs of the first connected parent (in the `post` field: this node's outputs)
- `ins` — list of the outputs of **all** connected parents, in order; use this for **join** nodes that take several inputs, e.g. `ins[0]['value']`, `ins[1]['status']`, or `len(ins)`
- `<output alias>` — each declared output has an alias box on the node (in its `out` section); typing `casenumber` there publishes that output as a flat variable, so later nodes can write `casenumber` (or `{{ casenumber }}` / `ctx['casenumber']`)
- `ctx` — the whole context dict; node outputs are also nested under auto-generated node names (e.g. `ctx['set_value_n1']`), but aliases are the recommended way to reference them

Examples:

```text
pre:        get_token['status'] == 200
post:       last['json']['id'] > 0
input:      Bearer {{ get_token['json']['access_token'] }}
input:      {{ user['json'] }}          # passes the dict itself, not a string
```

## A complete realistic example

```python
# nodes/json_path.py
"""Extract a value from a previous node's JSON output."""
from nbt.core.node_base import BaseNode, NodeError

class JsonPath(BaseNode):
    type_name = "json_path"
    label = "JSON Path"
    category = "Data"
    inputs = {
        "data": "{{ last['json'] }}",   # default pulls previous node's json
        "path": "a.b.0.c",              # dot path, ints index lists
        "required": True,
    }
    outputs = ["value"]

    def run(self, inputs, ctx):
        cur = inputs["data"]
        for part in str(inputs["path"]).split("."):
            try:
                cur = cur[int(part)] if part.lstrip("-").isdigit() else cur[part]
            except (KeyError, IndexError, TypeError):
                if inputs["required"]:
                    raise NodeError(f"path not found at {part!r}")
                return {"value": None}
        return {"value": cur}
```

## Grouping nodes in sub-folders

The `nodes/` directory is scanned **recursively**, so you can organise custom
nodes into sub-folders:

```
nodes/
  set_value.py
  pg/                 # group of Postgres nodes
    insert.py
    query.py
  http/
    get.py
    post.py
```

Every `.py` file found at any depth is loaded. A node's **top-level
sub-folder name becomes its default `category`** in the palette, so the files
under `nodes/pg/` show up grouped under "pg" automatically — unless the class
sets its own `category`, which always wins. Files and folders whose name
starts with `_` or `.` (including `__pycache__`) are skipped, and a helper
module like `nodes/pg/_helpers.py` can hold shared code without being treated
as a node file. Load errors are reported with their sub-path (e.g.
`pg/insert.py`).

## Node packages (install / share groups of nodes)

A *node package* is just a sub-folder of node files that can be installed,
updated and removed from the **Packages** view in the UI — from a **git URL**
or a **`.nbtpack` / `.zip` bundle** (you can also drag a bundle anywhere onto
the window). Add an optional manifest `nbt-package.json` at the package root:

```json
{
  "name": "pg",
  "version": "1.0.0",
  "description": "Postgres nodes",
  "author": "you",
  "requirements": ["psycopg2-binary>=2.9"]
}
```

`name` (defaulting to the folder/repo/zip name) becomes the install folder
`nodes/<name>/` and the default palette category. Anything in `requirements`
is `pip install`-ed automatically on install/update. A package laid out as

```
my-pg-nodes/            # git repo or zip root
  nbt-package.json
  insert.py
  query.py
  _shared.py            # helper, ignored by the scanner
```

installs to `nodes/pg/`. Installed packages are tracked in
`nodes/.nbt-packages.json` (a dot-file, ignored by the scanner); git packages
get an **Update** button (re-clone), and **Remove** deletes the folder and
unloads its nodes. Because node files execute Python on the server, only
install packages you trust.

Build a `.nbtpack` bundle from a package folder with the bundler script:

```bash
python tools/bundle_package.py path/to/your-package   # -> <name>-<version>.nbtpack
```

It validates the manifest, skips junk (`__pycache__`, dot-files, `*.pyc`),
checks at least one node file is present, and nests the contents under a single
`<name>/` folder so the package manager installs it correctly. See
`packages/nbt-file-nodes/` for a complete example package.

## Rules and good practice

- **One file can hold several node classes**; each needs its own `type_name`.
- Files and folders starting with `_` or `.` are ignored.
- **A broken node file never crashes the app** — the import error appears under *Load errors* in the palette. Duplicate `type_name`s are rejected with an error there too.
- Keep `run()` deterministic where possible and put the data in outputs rather than printing — outputs are persisted per step and visible in the step detail view.
- Heavy work is fine (runs happen on a background thread), but respect timeouts yourself (see `nodes/http_request.py`).
- You can import anything you like (stdlib or installed packages) — node code is ordinary Python. Only the *expression fields* are restricted.
- Test headless without the GUI: `python main.py --run "My Flow"` (exit code 0 = passed) — convenient for CI.

## Trigger (listener) nodes

Subclass `TriggerNode` instead of `BaseNode` to build a node that *emits events* rather than being executed. A trigger can stand alone or be the root of a subgraph; the flow is armed with the **Listen** button, and every `emit(...)` call runs the subgraph reachable from the trigger with the emitted dict as the trigger's outputs.

**Streaming / source nodes (process every item).** Because `emit(...)` runs the
downstream flow *synchronously*, a trigger that emits sequentially from one
thread applies natural backpressure — the next item isn't emitted until the
current one's run finishes, so nothing is dropped. That makes triggers a good
fit for finite streaming sources that fan out per item (read a file line by
line, page through an API, split a list). For a finite source, call
`self.finish()` when you're done to **auto-disarm the listener** (`finish` is
injected by the runtime; guard with `getattr(self, "finish", None)`). The
bundled **File Lines** node (`nodes/file_lines_trigger.py`) is a worked example:
it emits each line (one execution per line) and stops at EOF, or tails the file
when `tail` is on.

```python
# nodes/my_trigger.py
import threading, time
from nbt.core.node_base import TriggerNode

class Every5Min(TriggerNode):
    type_name = "every_5_min"
    label = "Every 5 Minutes"
    category = "Triggers"
    inputs = {"seconds": 300.0}
    outputs = ["tick", "time"]

    def start(self, emit, inputs, ctx):
        # called once when Listen is pressed; must NOT block —
        # do the watching on your own daemon thread
        self._stop = threading.Event()
        def loop():
            n = 0
            while not self._stop.wait(float(inputs["seconds"])):
                n += 1
                emit({"tick": n, "time": time.time()})
        threading.Thread(target=loop, daemon=True).start()

    def stop(self):
        # called on Stop listening / flow switch / app close
        self._stop.set()
```

Notes: `ctx` in `start()` contains the active environment's variables (and `{{ }}` templates in inputs are resolved against them). The node's *pre* field filters events — falsy means the event is silently dropped. Trigger nodes have no `post` field and no input pin. Events that arrive while a previous triggered run is still executing are dropped, so a slow flow never piles up. See `nodes/interval_trigger.py` and `nodes/file_watch_trigger.py`.

## Bundled nodes to learn from

| File | Shows |
|---|---|
| `nodes/set_value.py` | the smallest possible node |
| `nodes/python_eval.py` | reusing the engine's `safe_eval` |
| `nodes/http_request.py` | error handling, typed inputs, `NodeError` |
| `nodes/delay.py` | float input, side-effect node |
| `nodes/assert_equals.py` | the `check()` assert hook |

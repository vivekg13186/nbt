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

## Distributable build

Produce a self-contained zip (built UI included, so recipients only need
Python 3.10+):

```bash
python tools/build_dist.py                 # -> dist/nbt-<date>.zip
python tools/build_dist.py --version 1.2.0 # custom version label
python tools/build_dist.py --skip-frontend # reuse an existing webui/dist
```

It builds the web UI, assembles a clean tree (app + `nodes/` + `webui/dist` +
docs + helpers, excluding `node_modules`/`venv`/`.git`/caches/local DB), and
zips it. The recipient unzips and runs:

```bash
pip install -r requirements.txt
python api_server.py            # or ./run.sh  /  run.bat
```

The database is created fresh on first launch (Demo Flow seeded).

## Using the editor

The UI is dark-mode only. The tab bar holds open workflows (right-click a tab for Save / Rename / Duplicate / Close / Delete / Export JSON), with buttons to add, import (`.json`) and export workflows. The toolbar has the active workflow name, Add node, an editing group (undo, redo, auto-layout, zoom-to-fit, minimap toggle, and a shortcuts help button), the environment picker, Save / Listen / Run, and toggles for the bottom panel. The left rail switches between Workflows, Nodes, Packages, Environments, Listeners, Schedules and Executions. The **Packages** view installs groups of custom nodes from a git URL or a `.nbtpack`/`.zip` bundle (see `docs/CUSTOM_NODES.md`).

To add a node use the Nodes palette, the toolbar's Add node, or right-click the canvas. **Add node → 📝 Note** drops a free-text annotation block (double-click to edit; resizable) — notes are saved with the workflow but ignored by the engine. Drag from a node's `out` pin to another node's `in` pin to connect; a node grows extra input pins as you connect more parents (joins). The canvas pans/zooms with the mouse and is HiDPI-aware. The bottom panel has two tabs — an interactive **Shell** (a real PTY into the server) and a **Log** stream of run/listener output — toggled from the toolbar. The Executions page lists runs; click one for step inputs/outputs/error detail (Display nodes render their content here). You can also drag a workflow `.json` (imports as a new workflow) or a `.nbtpack`/`.zip` (installs as a package) anywhere onto the window. The Workflows sidebar can **export all workflows** (header download button) or **a single folder** (download icon on the folder header) as a `.zip` of importable `<folder>/<name>.json` files — handy for backing flows up to a git repo.

Each node has its declared **inputs**, a **pre** expression (falsy → node is skipped) and a **post** expression (falsy → node fails). Every text field has a code-editor dialog (the `</>`-style icon) for large values with JSON/HTML/JS highlighting. Edit a node's name via its title (right-click node → Title). Each declared output gets an alias box: type a variable name (e.g. `casenumber`) and that output is published flat into the context — later nodes can use `casenumber` / `{{ casenumber }}` / `ctx['casenumber']`. Use `last` for the first connected parent's outputs and `ins` for the list of all parents' outputs (joins).

### Editor shortcuts & navigation

The canvas keeps a full undo/redo history of node adds, moves, wiring, and field edits, and supports copy/paste **between workflows** (the clipboard survives switching tabs). A **minimap** in the bottom-right corner shows the whole graph and the current viewport — click or drag inside it to pan. **Auto-layout** arranges nodes into columns by dependency depth (one column past their deepest parent), and **zoom-to-fit** frames the entire graph. These are all on the toolbar's editing group, and most have keyboard shortcuts:

| Shortcut | Action |
| --- | --- |
| `Ctrl/⌘ Z` | Undo |
| `Ctrl/⌘ ⇧ Z` or `Ctrl/⌘ Y` | Redo |
| `Ctrl/⌘ C` / `X` / `V` | Copy / Cut / Paste selection (works across workflows) |
| `Ctrl/⌘ D` | Duplicate selection |
| `Ctrl/⌘ A` | Select all |
| `Ctrl/⌘ S` | Save workflow |
| `F` | Zoom to fit |
| `L` | Auto-layout |
| `Delete` | Delete selection |

Shortcuts act on the editor only while the canvas has keyboard focus, so click the canvas first; typing in node fields, dialogs, and the shell is never intercepted (`Backspace` won't delete a node). The same shortcut list is available from the keyboard-icon button in the toolbar.

## Versioning (snapshots)

Right-click a tab → **Snapshot version** to save a read-only copy of the workflow's current graph (with an optional label). **Version history…** opens a drawer listing all snapshots; from there you can **View** a snapshot (read-only canvas), **Run** it (recorded as `Name (vN)`), **Export** its JSON, or delete it. Snapshots are immutable — editing always happens on the live workflow.

## Execution rules (DAG)

A flow is a directed acyclic graph: nodes may have multiple inputs and outputs, branches and joins are allowed, and a graph may contain several disconnected subgraphs — the only structural rule is no cycles. Nodes execute in topological order; a node's `last` is its first connected parent's outputs. A node fails if `run()` raises, if the class `check()` hook raises, or if its post expression is falsy. Any failure fails the whole flow immediately; otherwise it passes. Every run and every step is recorded in SQLite.

While a Run is in progress the toolbar's Run button becomes a **Stop** button (and each running row in the Executions view has its own Stop); cancelling marks the execution `cancelled`. Cancellation is cooperative — it is checked between nodes (and between fan-out items), so an already-running node call, e.g. a long HTTP request or Delay, finishes before the run stops. Cancelling also propagates into subflows.

## Fan-out (Split)

A **Split** node runs the subgraph downstream of it **once per item** during a normal Run — the Run-time equivalent of the Emit Array trigger, without Listen. Give **Split (Fan-out)** ⑂ a JSON array (or a `{{ template }}` that yields a list, e.g. an environment variable or an upstream output); use **Split CSV** ⑂ to fan out over the rows of a CSV file (each `item` is a dict keyed by the header row). For every element the engine seeds `item` and `index` into the context — and sets the split's output aliases per item — then runs every node reachable from the split. Each iteration records its own steps (labelled `node #0`, `node #1`, …) under the single execution.

Iterations are independent: by default one failing item does not stop the others (so you see every per-item result), and the Run fails if any item failed. Set the split's `stop_on_error` input to abort on the first failure instead. Splits may nest (a split inside a split's subgraph fans out per outer item). Keep a split's subgraph dedicated — joining a split's inner nodes back into the outer graph is not supported, since inner nodes run in isolated per-item contexts.

## Trigger (listener) flows

A flow can contain a **trigger node** (marked ⚡) — *Interval Trigger* (emit every N seconds), *File Watch Trigger* (emit when a file changes), *File Lines* (emit each line of a file), or *Emit Array* (emit each element of an array). A trigger need not be connected to anything; it can stand alone or be the root of a subgraph (exactly one trigger per flow). Trigger flows aren't Run; press **Listen** to arm the trigger. Every emitted event executes the subgraph reachable from the trigger (in topological order, same as Run) with the trigger's outputs seeded into the context, and each event becomes its own recorded execution. The trigger's *pre* field is an event filter — falsy events are ignored without creating an execution.

Multiple flows can listen at once (one listener per flow, each on a snapshot of its graph taken when armed). The toolbar's **Listen** button arms/stops the current flow; the **Listeners** view is a live table with per-listener stats (events / runs / filtered / busy-skips / last result) and Stop / Stop All. `emit()` runs the flow synchronously, so events arriving while the previous run is still in progress are dropped and counted (busy-skips) — sequential sources like File Lines and Emit Array therefore never drop. Finite sources (File Lines at EOF, Emit Array after the last element) auto-stop their listener. Listeners live in the server process, so they keep firing with no browser tab open.

## Scheduled runs (cron)

The **Schedules** view (clock icon in the rail) runs a workflow automatically on a cron cadence — the time-based counterpart to Listen. Create a schedule by picking a workflow, a cron expression, and an optional environment; toggle it on/off, **Run now**, edit, or delete from the table, which also shows each schedule's last result and next fire time. Schedules are persisted in the database, so they survive restarts (unlike listeners, which are armed in-memory), and a server-side thread fires them on each minute boundary in server local time.

The cron syntax is the classic five fields — `minute hour day-of-month month day-of-week` — supporting `*`, lists (`1,2`), ranges (`1-5`), steps (`*/5`), and the macros `@hourly` / `@daily` / `@weekly` / `@monthly` / `@yearly`; day-of-week is `0-6` with Sunday `0` (`7` also works). The editor offers presets (every minute, hourly, daily 09:00, weekdays, weekly, monthly). Day-of-month and day-of-week follow standard cron: when both are restricted a tick matches if *either* does. Each fire is a normal recorded execution (visible in Executions and cancellable with Stop); a schedule whose previous run is still going is skipped so a slow flow never piles up. Fan-out (Split) and subflows work inside scheduled runs exactly as in a manual Run.

## Environments

Environments are named sets of variables (e.g. `staging`, `prod`) managed in the **Environments** view — variables are a JSON object like `{"base_url": "https://stg.example.com", "token": "abc"}` edited in the JSON editor. Pick the active environment in the toolbar dropdown before running or listening; its variables are injected into the context, usable as `{{ base_url }}` in inputs, `base_url` in pre/post expressions, `env['token']` or `ctx['token']` anywhere. Each execution records which environment it ran with.

## Expressions and templating

The `pre` / `post` fields and `{{ ... }}` templates inside string inputs are Python expressions evaluated against the context: `last` is the first connected parent's outputs, `ins` is the list of all parents' outputs, output aliases and environment variables are available as plain names, and `ctx` is the whole dict. Helpers `log(...)` (write to the Log tab) and `run_flow(name, vars)` (run a subflow) are also callable. Example: input `{{ upper }}`, post `last['status'] == 200`.

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

Bundled nodes: Set Value, Python Eval, HTTP Request, Delay, Assert Equals, Log, Subflow (run another saved flow as a step); **Flow** — Split (Fan-out) ⑂ and Split CSV ⑂ (run the downstream subgraph once per list element / CSV row, in a normal Run); **Display** — Display Code (shows JSON/JS/text), Show Image (file path, URL or data URI); triggers — Interval Trigger ⚡, File Watch Trigger ⚡, File Lines ⚡ (streams a file line by line, running the flow per line), Emit Array ⚡ (emits each element of an array, running the flow per element).

Custom fan-out nodes subclass `SplitNode` and implement `items(self, inputs, ctx)` (return the list to iterate); custom listener nodes subclass `TriggerNode`. See `docs/CUSTOM_NODES.md`.

### Subflows

The **Subflow** node runs another saved flow as a single step. Give it the target flow's `name` and an `inputs` JSON object (seeded as named variables in the subflow). Outputs: `output` (a dict of all the subflow's published output aliases — alias it to e.g. `sub`, then read `sub['result']`), plus `execution_id` and `status`. The subflow runs as its own recorded execution (visible in Executions), under the same environment, and recursive calls are detected and fail cleanly. Node code can call this directly via `ctx["run_flow"](name, vars)`.

The **File** category (Read/Write/Append File, Read/Write JSON, List Directory, File Exists, Delete File) ships as a separate installable package — `packages/nbt-file-nodes/` (build `nbt-file-nodes.nbtpack`). Install it from the **Packages** view (upload the bundle or point it at a git repo).

# NBT Web UI

The single-page front-end for **NBT (Node Based Tester)**, built with
**Vite + React + TypeScript + Ant Design**, with the workflow canvas powered by
**LiteGraph.js**. It is the only UI. It talks to NBT through the **FastAPI**
backend (`api_server.py`) that wraps the engine, registry and SQLite database.

## Architecture

```
webui/ (React SPA)  ──HTTP /api──▶   api_server.py (FastAPI)  ──▶  nbt.core (Engine,
        │                                                           Registry, Listener,
        ├──WS /api/shell──▶  PTY shell (bottom "Shell" tab)         PackageManager)
        ├──WS /api/logs ──▶  run/listener output ("Log" tab)   ──▶  data/nbt.db (SQLite)
        ├──/api/media/* ──▶  served images (Show Image node)
        └──(prod) served from webui/dist by api_server.py
```

In production `api_server.py` serves the built `webui/dist` at `/`, so it is a
single origin and a single command. In development the Vite dev server proxies
`/api` (REST + WebSocket) to `http://localhost:8000`.

## Run

Production (single command, after building once):

```bash
pip install -r requirements.txt        # from the repo root
cd webui && npm install && npm run build && cd ..
python api_server.py                    # http://localhost:8000
```

Development (hot reload, two processes):

```bash
python api_server.py                    # API -> http://localhost:8000
cd webui && npm run dev                  # SPA -> http://localhost:5173
```

## Build (production)

```bash
cd webui
npm run build                        # outputs to webui/dist/
```

`api_server.py` serves `webui/dist/` automatically at `/` when it exists.

## Layout

- **Tab bar** — open workflows as tabs. Right-click a tab (or click the `≡`
  glyph) for **Save / Rename / Duplicate / Close / Delete / Export ▸ JSON|YAML**.
  `+` adds a workflow; the up/down-arrow buttons **import** (`.json` / `.yaml`)
  and **export** (JSON or YAML) the active workflow. Files carry the flow's name
  and folder — see `../docs/FLOW_FILES.md`.
- **Toolbar** — active workflow name, **Add node**, an editing group (**undo**,
  **redo**, **auto-layout**, **zoom-to-fit**, **minimap** toggle, and a
  **shortcuts** help button), **environment** selector, **Save**, **Listen**,
  **Run**, and toggles for the **Log** and **Shell** tabs.
- **Left icon rail** — switch between **Workflows**, **Nodes**, **Packages**,
  **Environments**, **Listeners**, **Schedules**, and **Executions**. The rail
  also shows/hides the sidebar.
- **Sidebar** — searchable list of workflows, the node palette, or environments.
- **Main panel**
  - *Workflows*: the LiteGraph canvas (HiDPI-aware). Right-click the canvas, use
    **Add node**, or click a node in the Nodes palette; drag `out → in` to
    connect (nodes grow extra input pins for joins); pan/zoom with the mouse.
    Each node field has a `</>` code-editor dialog (CodeMirror, JSON/HTML/JS
    highlighting) for large values. The canvas has **undo/redo**,
    **copy/paste between workflows**, **duplicate**, **auto-layout**,
    **zoom-to-fit**, and a draggable **minimap**; see *Keyboard shortcuts* below.
  - *Nodes*: searchable palette grouped by category; click to add to the canvas.
  - *Packages*: install/update/remove node packages from a git URL or a
    `.nbtpack`/`.zip` bundle (with load-error reporting).
  - *Environments*: a JSON code editor (CodeMirror) with live validation.
  - *Listeners*: live table of armed trigger flows with per-listener Stop.
  - *Schedules*: cron-scheduled flow runs — create with a flow picker, cron
    expression (presets provided) and optional environment; enable/disable,
    Run now, edit, delete. Shows each schedule's last result and next fire
    time. Schedules persist server-side and fire on the minute in server time.
  - *Executions*: run history; click a row for step-by-step inputs/outputs
    (Display Code / Show Image nodes render their content here). A **Run** in
    progress can be cancelled — the toolbar Run button becomes **Stop**, and
    running rows here have their own Stop; cancelled runs show as `cancelled`.
    A **Split** ⑂ node fans out: the downstream subgraph runs once per list /
    CSV item, with per-item steps labelled `node #0`, `node #1`, …
- **Bottom panel** — two tabs: an interactive **Shell** (xterm.js over a PTY
  WebSocket) and a **Log** stream of run/listener/package output.
- **Drag-and-drop** anywhere on the window: a `.json` / `.yaml` imports as a new
  workflow; a `.nbtpack`/`.zip` installs as a node package.

## Keyboard shortcuts

Shortcuts act on the editor only while the canvas has focus (click it first), so
typing in node fields, dialogs, and the shell is never intercepted:

| Shortcut | Action |
| --- | --- |
| `Ctrl/⌘ Z` | Undo |
| `Ctrl/⌘ ⇧ Z` or `Ctrl/⌘ Y` | Redo |
| `Ctrl/⌘ C` / `X` / `V` | Copy / Cut / Paste (works across workflows) |
| `Ctrl/⌘ D` | Duplicate selection |
| `Ctrl/⌘ A` | Select all |
| `Ctrl/⌘ S` | Save workflow |
| `F` | Zoom to fit |
| `L` | Auto-layout |
| `Delete` | Delete selection |

The same list is in the toolbar's keyboard-icon popover.

## Notes

- Dark mode only; CodeMirror uses the VS Code Dark theme.
- The graph JSON also persists UI metadata (node size, group boxes) that the
  engine ignores; `pre` / `post` fields and output aliases are the data the
  engine reads.
- This is an internal, single-user tool with no authentication, and the
  Shell tab is a real server shell — don't expose it beyond a trusted network
  (expression fields evaluate Python server-side).

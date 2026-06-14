# NBT Web UI

The single-page front-end for **NBT (Node Based Tester)**, built with
**Vite + React + TypeScript + Ant Design**, with the workflow canvas powered by
**LiteGraph.js**. It is the only UI. It talks to NBT through the **FastAPI**
backend (`api_server.py`) that wraps the engine, registry and SQLite database.

## Architecture

```
webui/ (React SPA)  ──HTTP /api──▶   api_server.py (FastAPI)  ──▶  nbt.core (Engine,
        │                                                           Registry, Listener)
        ├──WS /api/shell──▶  PTY shell (bottom terminal)       ──▶  data/nbt.db (SQLite)
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
  glyph) for **Save / Rename / Duplicate / Close / Delete**. `+` adds a new
  workflow. Drag-and-drop a workflow `.json` file anywhere to import it.
- **Toolbar** — active workflow name, **Add node**, **environment** selector,
  **Save**, **Listen**, **Run**, and the terminal toggle.
- **Left icon rail** — switch between **Workflows**, **Nodes**,
  **Environments**, **Listeners**, and **Executions**. The rail also
  shows/hides the sidebar.
- **Sidebar** — searchable list of workflows, the node palette, or environments.
- **Main panel**
  - *Workflows*: the LiteGraph canvas. Right-click the canvas, use **Add
    node**, or click a node in the Nodes palette; drag `out → in` to connect;
    pan/zoom with the mouse.
  - *Environments*: a JSON code editor (CodeMirror) with live validation.
  - *Listeners*: live table of armed trigger flows with per-listener Stop.
  - *Executions*: run history; click a row for step-by-step inputs/outputs.
- **Terminal** — a toggleable interactive shell (xterm.js) into the server,
  over a PTY WebSocket.

## Notes

- Dark mode only.
- The graph serialization format and node-widget mapping match the engine's
  DAG node format (`pre` / `post` fields, output aliases).
- This is an internal, single-user tool with no authentication, and the
  terminal is a real server shell — don't expose it beyond a trusted network
  (expression fields evaluate Python server-side).

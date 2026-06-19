# NBT Flows — VS Code extension

Browse, edit, and run **NBT** workflows directly from a running NBT
server. Flows appear as **virtual YAML files** (`nbt://` scheme): open one to
download it, **save (Ctrl/Cmd+S) to upload it back to the same flow**, and run
it from the tree or the editor title bar — no local files to manage.

## Features

- **Workflows** view in the activity bar: folders → flows, pulled live from the
  server (`GET /api/flows`).
- **Open** a flow → it downloads as YAML (`GET /api/flows/{id}/export?format=yaml`)
  and opens in a normal editor with YAML highlighting.
- **Save** → uploads back to the *same* flow in place
  (`POST /api/flows/import` with `flow_id`); editing the file's `name:` /
  `folder:` renames / moves it. No client-side YAML parser needed — the server
  parses.
- **Run** (▶ on a tree item or the editor title) → `POST /api/flows/{id}/run`;
  the step results stream into the **NBT** output channel and the final
  pass/fail shows as a notification. Set `nbt.environment` to run with an
  environment.
- **New** / **Delete** flows from the view.

See `docs/FLOW_FILES.md` in the NBT repository for the YAML/JSON file syntax.

## Settings

- `nbt.serverUrl` — base URL of the NBT server (default `http://localhost:8000`).
- `nbt.environment` — environment name used when running (blank = none).

## Develop / run

Requires Node 18+ (VS Code's runtime). No runtime dependencies.

```bash
cd vscode-extension
npm install        # dev deps only (typescript, @types/*)
npm run compile    # tsc -> out/extension.js
```

Then press **F5** in VS Code (with this folder open) to launch an Extension
Development Host. Start an NBT server first (`python api_server.py`).

## Package / install

```bash
npm install -g @vscode/vsce
vsce package                 # -> nbt-flows-0.1.0.vsix
code --install-extension nbt-flows-0.1.0.vsix
```

## How it works

The extension is a thin client over the NBT HTTP API. A `FileSystemProvider`
for the `nbt` scheme maps `nbt:/<flow id>/<name>.yaml`:

- `readFile`  → `GET /api/flows/{id}/export?format=yaml`
- `writeFile` → `POST /api/flows/import` (`flow_id=<id>`, file = the buffer)

The flow **id** is the stable key in the URI, so renaming inside the file never
breaks the round-trip.

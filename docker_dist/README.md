# docker_dist — run NBT in Docker

Two steps: **stage** the runtime files (build the UI + copy the Python app), then
**build & run** a tiny image that only runs the app.

```bash
# 1) build the web UI and stage everything into docker_dist/app/
./docker_dist/build.sh
#    (already have webui/dist? skip the rebuild:)
./docker_dist/build.sh --skip-build

# 2) build the image and run it
cd docker_dist
docker build -t nbt .
docker run -p 8000:8000 -v nbt-data:/app/data nbt     # http://localhost:8000
```

## What goes where

`build.sh` populates `docker_dist/app/` with:

- `api_server.py`, `main.py`, `requirements.txt`
- `nbt/` (engine, API, db)
- `nodes/` — the **core** built-in nodes only (top-level `.py`)
- `webui/dist/` — the built single-page UI

The `Dockerfile` here is **run-only**: it installs the Python deps and starts
`api_server.py` (host `0.0.0.0`, port `8000`, DB at `/app/data/nbt.db`). It does
no UI building — that already happened in step 1.

## Notes

- The SQLite database (flows, environments, executions, schedules) lives at
  `/app/data/nbt.db`; mount the `nbt-data` volume to persist it.
- The image includes `bash` (for the Shell tab) and `git` (git-based package
  installs). Node *packages* and their extra pip deps are installed at runtime
  from the Packages view (not persisted unless you also mount `nodes/`).
- No auth, server-side Python eval, and an interactive shell — keep it on a
  trusted network, don't expose the container publicly.

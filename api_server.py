"""NBT server — REST + WebSocket API plus the built React web UI (webui/).

    pip install -r requirements.txt
    cd webui && npm install && npm run build   # produces webui/dist
    python api_server.py                        # http://localhost:8000
    python api_server.py --port 9000
    python api_server.py --db data/nbt.db

If webui/dist exists it is served at / (single command, production). During
frontend development run the Vite dev server (npm run dev) which proxies /api
here instead.
"""

import argparse
import sys
from pathlib import Path

from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from main import bootstrap          # noqa: E402  (reuse seeding + registry)
from nbt.api import create_app      # noqa: E402


def main():
    ap = argparse.ArgumentParser(description="NBT API + web UI server")
    ap.add_argument("--db", help="path to sqlite database file")
    ap.add_argument("--host", default="127.0.0.1", help="bind host")
    ap.add_argument("--port", type=int, default=8000, help="port (default 8000)")
    args = ap.parse_args()

    import uvicorn
    db, registry = bootstrap(args.db)
    app = create_app(db, registry)

    # Serve the built SPA at / (API routes were registered first, so they
    # take precedence). html=True serves index.html for the app root.
    dist = ROOT / "webui" / "dist"
    if dist.is_dir():
        app.mount("/", StaticFiles(directory=str(dist), html=True), name="ui")
        ui_msg = "web UI: built (served at /)"
    else:
        ui_msg = ("web UI: webui/dist not found - run `cd webui && npm run "
                  "build`, or use the Vite dev server")

    print(f"NBT on http://{args.host}:{args.port}  "
          f"({len(registry.types)} node types)\n{ui_msg}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()

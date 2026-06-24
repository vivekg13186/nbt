#!/usr/bin/env bash
#
# Stage everything the Docker image needs into docker_dist/app/:
#   - the BUILT web UI (webui/dist)
#   - the Python app (api_server.py, main.py, nbt/, core nodes, requirements)
#
# Then build the image from this folder (the Dockerfile here only RUNS the app;
# it does no building of its own):
#
#   ./docker_dist/build.sh            # build the UI, then stage files
#   ./docker_dist/build.sh --skip-build   # reuse an existing webui/dist
#   cd docker_dist && docker build -t nbt .
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"     # docker_dist/
ROOT="$(cd "$HERE/.." && pwd)"            # repo root
APP="$HERE/app"

SKIP_BUILD=0
[ "${1:-}" = "--skip-build" ] && SKIP_BUILD=1

if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "==> building the web UI (webui/dist)"
  ( cd "$ROOT/webui" && npm ci && npm run build )
fi

if [ ! -f "$ROOT/webui/dist/index.html" ]; then
  echo "ERROR: webui/dist not found. Build it first (omit --skip-build)." >&2
  exit 1
fi

echo "==> staging runtime files into $APP"
rm -rf "$APP"
mkdir -p "$APP/nodes" "$APP/webui"

# python app + deps
cp "$ROOT/api_server.py" "$ROOT/main.py" "$ROOT/requirements.txt" "$APP/"
cp -R "$ROOT/nbt" "$APP/nbt"

# core nodes only (top-level .py); installed node-package subfolders need extra
# pip deps and are installed at runtime from the Packages view instead
find "$ROOT/nodes" -maxdepth 1 -type f -name "*.py" -exec cp {} "$APP/nodes/" \;

# the built single-page app
cp -R "$ROOT/webui/dist" "$APP/webui/dist"

# drop python caches
find "$APP" -name "__pycache__" -type d -prune -exec rm -rf {} + 2>/dev/null || true

echo "==> done. Staged $(find "$APP" -type f | wc -l | tr -d ' ') files."
echo "    Next:  cd docker_dist && docker build -t nbt .  &&  docker run -p 8000:8000 -v nbt-data:/app/data nbt"

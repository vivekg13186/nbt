# Run-only image: everything is already built/staged into ./app by build.sh,
# so this Dockerfile just installs the Python deps and starts the server.
# (Run ../docker_dist/build.sh first to populate ./app.)
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# bash: the interactive Shell tab (PTY); git: git-based node-package installs
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# python deps first (cached unless requirements change)
COPY app/requirements.txt ./
RUN pip install -r requirements.txt

# the staged app: api_server.py, main.py, nbt/, nodes/, webui/dist
COPY app/ ./

# SQLite DB + flows live here; mount a volume to persist them
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health').status==200 else 1)" || exit 1

CMD ["python", "api_server.py", "--host", "0.0.0.0", "--port", "8000", "--db", "/app/data/nbt.db"]

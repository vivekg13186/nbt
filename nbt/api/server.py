"""FastAPI app exposing NBT flows, environments, executions and listeners.

The app is intentionally thin: every endpoint delegates to the same
``Database`` / ``Engine`` / ``NodeRegistry`` / ``FlowListener`` objects the
NiceGUI UI uses, so both front-ends stay in sync. Run it with::

    python api_server.py --port 8000

and point the Vite dev server (webui/) at it.
"""

from __future__ import annotations

import asyncio
import functools
import io
import json
import re
import shutil
import tempfile
import threading
import time
import uuid
import zipfile
from collections import deque
from pathlib import Path
from typing import Any, Optional

from fastapi import (FastAPI, File, HTTPException, Response, UploadFile,
                     WebSocket, WebSocketDisconnect)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.concurrency import run_in_threadpool
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from ..core.listener import FlowListener
from ..core.engine import Engine
from ..core.packages import PackageManager, PackageError
from ..core.scheduler import FlowScheduler, CronError, cron_next, parse_cron


# --------------------------------------------------------------------------
# Log bus: collects human-readable run/listener lines and fans them out to
# any connected WebSocket clients (the bottom "terminal" console).
# --------------------------------------------------------------------------
class LogBus:
    def __init__(self, history: int = 500):
        self._history: deque[dict] = deque(maxlen=history)
        self._subs: set[asyncio.Queue] = set()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._lock = threading.Lock()

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def emit(self, text: str, level: str = "info") -> None:
        """Thread-safe. Callable from listener threads or request handlers."""
        line = {"ts": time.time(), "level": level, "text": text}
        with self._lock:
            self._history.append(line)
            subs = list(self._subs)
        loop = self._loop
        for q in subs:
            if loop is not None:
                loop.call_soon_threadsafe(q.put_nowait, line)

    def history(self) -> list[dict]:
        with self._lock:
            return list(self._history)

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        with self._lock:
            self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        with self._lock:
            self._subs.discard(q)


# --------------------------------------------------------------------------
# Listener manager: one FlowListener per flow_id, mirroring WebApp.listeners.
# --------------------------------------------------------------------------
class ListenerManager:
    def __init__(self, engine: Engine, logbus: LogBus):
        self.engine = engine
        self.logbus = logbus
        self.listeners: dict[str, FlowListener] = {}
        self._lock = threading.Lock()
        self._media_register = None  # set by create_app once media dir exists

    def start(self, flow: dict, env_name=None, env_vars=None) -> FlowListener:
        fid = flow["id"]

        def _done(lst: FlowListener):
            res = lst.last_result or (None, "?", None)
            exec_id, status, _ = res
            self.logbus.emit(
                f"[listen] {flow['name']}: event -> {status} "
                f"(exec {exec_id})",
                level="ok" if status == "passed" else "error")

        def _finished(lst: FlowListener):
            # a finite trigger (e.g. File Lines at EOF) self-disarmed
            with self._lock:
                self.listeners.pop(fid, None)
            self.logbus.emit(
                f"[listen] '{flow['name']}' finished ({lst.runs} runs)",
                level="ok")

        with self._lock:
            if fid in self.listeners:
                raise ValueError("flow is already listening")
            listener = FlowListener(
                self.engine, flow, env_name, env_vars,
                on_run_done=_done, on_done=_finished,
                log=lambda m: self.logbus.emit("    " + m, level="info"),
                media=self._media_register)
            self.listeners[fid] = listener
        # start() outside the lock: a finite trigger can finish (and call
        # _finished, which needs the lock) before start() returns.
        try:
            listener.start()  # raises on invalid flow
        except Exception:
            with self._lock:
                self.listeners.pop(fid, None)
            raise
        self.logbus.emit(f"[listen] armed '{flow['name']}'", level="ok")
        return listener

    def stop(self, flow_id: str) -> bool:
        with self._lock:
            lst = self.listeners.pop(flow_id, None)
        if lst is None:
            return False
        lst.stop()
        self.logbus.emit(f"[listen] stopped '{lst.flow['name']}'")
        return True

    def stop_all(self) -> int:
        with self._lock:
            items = list(self.listeners.items())
            self.listeners.clear()
        for _, lst in items:
            lst.stop()
        if items:
            self.logbus.emit(f"[listen] stopped all ({len(items)})")
        return len(items)

    def stats(self) -> list[dict]:
        with self._lock:
            items = list(self.listeners.items())
        out = []
        for fid, lst in items:
            res = lst.last_result
            out.append({
                "flow_id": fid,
                "flow_name": lst.flow["name"],
                "environment": lst.environment,
                "active": lst.active,
                "events": lst.events,
                "runs": lst.runs,
                "filtered": lst.filtered,
                "skipped_busy": lst.skipped_busy,
                "last_status": res[1] if res else None,
                "last_exec_id": res[0] if res else None,
            })
        return sorted(out, key=lambda r: r["flow_name"].lower())


# --------------------------------------------------------------------------
# Node metadata (same shape WebApp.node_metas produces for LiteGraph).
# --------------------------------------------------------------------------
def node_metas(registry) -> list[dict]:
    metas = []
    for tname, cls in sorted(registry.types.items()):
        params = []
        for p, d in cls.inputs.items():
            if isinstance(d, bool):
                kind = "bool"
            elif isinstance(d, int):
                kind = "int"
            elif isinstance(d, float):
                kind = "float"
            else:
                kind = "text"
            params.append({"name": p, "default": d, "kind": kind})
        metas.append({
            "type": tname, "label": cls.label,
            "category": cls.category or "General", "params": params,
            "outputs": list(cls.outputs),
            "is_trigger": bool(getattr(cls, "is_trigger", False)),
            "is_split": bool(getattr(cls, "is_split", False)),
        })
    return metas


# --------------------------------------------------------------------------
# Request bodies
# --------------------------------------------------------------------------
class FlowCreate(BaseModel):
    name: str
    graph: Optional[dict] = None
    folder: Optional[str] = None


class FlowPatch(BaseModel):
    name: Optional[str] = None
    graph: Optional[dict] = None
    folder: Optional[str] = None
    set_folder: bool = False  # allow clearing folder to null


class DuplicateBody(BaseModel):
    name: str


class EnvBody(BaseModel):
    name: str
    vars: dict[str, Any] = {}


class EnvPatch(BaseModel):
    name: Optional[str] = None
    vars: Optional[dict[str, Any]] = None


class RunBody(BaseModel):
    environment: Optional[str] = None


class GitInstallBody(BaseModel):
    url: str
    ref: Optional[str] = None


class VersionCreate(BaseModel):
    label: Optional[str] = None
    graph: Optional[dict] = None  # snapshot this graph; else the flow's saved one


class ScheduleCreate(BaseModel):
    flow_id: str
    cron: str
    environment: Optional[str] = None
    enabled: bool = True


class SchedulePatch(BaseModel):
    cron: Optional[str] = None
    environment: Optional[str] = None
    set_environment: bool = False  # allow clearing the environment to null
    enabled: Optional[bool] = None


# --------------------------------------------------------------------------
# App factory
# --------------------------------------------------------------------------
def create_app(db, registry) -> FastAPI:
    engine = Engine(registry, db)
    logbus = LogBus()
    listeners = ListenerManager(engine, logbus)
    packages = PackageManager(registry.nodes_dir, registry)

    # In-flight Run executions, so a Stop button can cancel them. Maps an
    # execution id to its cancel token (a threading.Event) and originating
    # flow. A token is shared with any subflows the run spawns.
    running: dict[str, dict] = {}
    running_lock = threading.Lock()

    def _register_run(exec_id, cancel, flow_id):
        with running_lock:
            running[exec_id] = {"cancel": cancel, "flow_id": flow_id}

    def _unregister_token(cancel):
        with running_lock:
            for k in [k for k, v in running.items() if v["cancel"] is cancel]:
                running.pop(k, None)

    # Served media folder (temp): display nodes copy images here and reference
    # them by URL (/api/media/<file>) instead of inlining base64.
    media_dir = Path(tempfile.mkdtemp(prefix="nbt-media-"))

    def media_register(path: str) -> str:
        src = Path(path)
        name = f"{uuid.uuid4().hex}{src.suffix.lower()}"
        shutil.copyfile(src, media_dir / name)
        return f"/api/media/{name}"

    listeners._media_register = media_register

    # Cron scheduler: runs persisted schedules on their cadence. Scheduled
    # runs register in the same `running` map so they're cancellable too.
    scheduler = FlowScheduler(
        engine, db,
        log=lambda m: logbus.emit("    " + m, level="info"),
        media=media_register,
        register=_register_run, unregister=_unregister_token)

    app = FastAPI(title="NBT API", version="1.0")
    app.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_methods=["*"],
        allow_headers=["*"],
    )
    app.mount("/api/media", StaticFiles(directory=str(media_dir)),
              name="media")

    @app.on_event("startup")
    async def _bind():
        logbus.bind_loop(asyncio.get_running_loop())
        scheduler.start()

    @app.on_event("shutdown")
    async def _unbind():
        scheduler.stop()

    def _env_lookup(name):
        """Return (env_name, env_vars) or (None, None); 404 if name unknown."""
        if not name:
            return None, None
        env = db.get_environment_by_name(name)
        if env is None:
            raise HTTPException(404, f"environment not found: {name!r}")
        return env["name"], env["vars"]

    # ---------------- meta ----------------
    @app.get("/api/health")
    def health():
        return {"ok": True, "nodes": len(registry.types),
                "load_errors": registry.errors}

    @app.get("/api/nodes")
    def nodes():
        return {"nodes": node_metas(registry),
                "load_errors": [{"file": f, "error": e}
                                for f, e in registry.errors]}

    # ---------------- flows ----------------
    @app.get("/api/flows")
    def list_flows():
        return db.list_flows()

    @app.get("/api/flows/export")
    def export_flows(folder: Optional[str] = None):
        """Zip of one importable <name>.json per flow (graph only), optionally
        limited to a single folder. `folder=""` exports the ungrouped flows."""
        def _safe(s):
            return re.sub(r"[^A-Za-z0-9 _.\-]+", "_", s or "").strip() or "flow"

        rows = db.list_flows()
        if folder is not None:
            rows = [r for r in rows if (r.get("folder") or "") == folder]
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for r in rows:
                flow = db.get_flow(r["id"])
                if not flow:
                    continue
                fld = (flow.get("folder") or "").strip()
                path = (f"{_safe(fld)}/" if fld else "") + _safe(flow["name"]) \
                    + ".json"
                z.writestr(path, json.dumps(flow["graph"], indent=2))
        fname = (_safe(folder) if folder else "nbt-flows") + ".zip"
        return Response(
            content=buf.getvalue(), media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{fname}"'})

    @app.get("/api/flows/{flow_id}")
    def get_flow(flow_id: str):
        flow = db.get_flow(flow_id)
        if flow is None:
            raise HTTPException(404, "flow not found")
        flow["listening"] = flow_id in listeners.listeners
        return flow

    @app.post("/api/flows")
    def create_flow(body: FlowCreate):
        name = body.name.strip()
        if not name:
            raise HTTPException(400, "name required")
        if db.get_flow_by_name(name):
            raise HTTPException(409, "a flow with that name already exists")
        folder = (body.folder or "").strip() or None
        fid = db.create_flow(name, body.graph, folder)
        logbus.emit(f"[flow] created '{name}'")
        return db.get_flow(fid)

    @app.patch("/api/flows/{flow_id}")
    def patch_flow(flow_id: str, body: FlowPatch):
        flow = db.get_flow(flow_id)
        if flow is None:
            raise HTTPException(404, "flow not found")
        if body.name is not None:
            new = body.name.strip()
            if not new:
                raise HTTPException(400, "name cannot be empty")
            other = db.get_flow_by_name(new)
            if other and other["id"] != flow_id:
                raise HTTPException(409, "name already in use")
            db.rename_flow(flow_id, new)
            lst = listeners.listeners.get(flow_id)
            if lst is not None:
                lst.flow["name"] = new
        if body.graph is not None:
            db.save_graph(flow_id, body.graph)
        if body.set_folder:  # explicit set (folder=None/"" clears it)
            db.set_flow_folder(flow_id, (body.folder or "").strip() or None)
        return db.get_flow(flow_id)

    @app.post("/api/flows/{flow_id}/duplicate")
    def duplicate_flow(flow_id: str, body: DuplicateBody):
        if db.get_flow(flow_id) is None:
            raise HTTPException(404, "flow not found")
        name = body.name.strip()
        if db.get_flow_by_name(name):
            raise HTTPException(409, "a flow with that name already exists")
        new_id = db.duplicate_flow(flow_id, name)
        return db.get_flow(new_id)

    @app.delete("/api/flows/{flow_id}")
    def delete_flow(flow_id: str):
        if db.get_flow(flow_id) is None:
            raise HTTPException(404, "flow not found")
        listeners.stop(flow_id)
        db.delete_flow(flow_id)
        return {"ok": True}

    async def _run_graph(flow_id, flow_name, graph, env_name, env_vars):
        logbus.emit(f"[run] '{flow_name}'"
                    + (f" (env {env_name})" if env_name else ""))
        node_log = lambda m: logbus.emit("    " + m, level="info")
        cancel = threading.Event()

        def on_start(eid):
            _register_run(eid, cancel, flow_id)

        try:
            exec_id, status, error = await run_in_threadpool(
                functools.partial(
                    engine.execute, flow_id, flow_name, graph,
                    env_name, env_vars, log=node_log, media=media_register,
                    cancel=cancel, on_start=on_start))
        finally:
            _unregister_token(cancel)
        for st in db.get_steps(exec_id):
            line = f"  [{st['status']:>7}] {st['node_name']} ({st['node_type']})"
            logbus.emit(line,
                        level={"passed": "ok", "failed": "error"}.get(
                            st["status"], "info"))
            if st["error"]:
                logbus.emit("           " + st["error"].splitlines()[0],
                            level="error")
        logbus.emit(f"[run] {flow_name}: {status.upper()}",
                    level="ok" if status == "passed" else "error")
        return {"execution_id": exec_id, "status": status, "error": error}

    @app.post("/api/flows/{flow_id}/run")
    async def run_flow(flow_id: str, body: RunBody):
        flow = db.get_flow(flow_id)
        if flow is None:
            raise HTTPException(404, "flow not found")
        env_name, env_vars = _env_lookup(body.environment)
        return await _run_graph(flow["id"], flow["name"], flow["graph"],
                                env_name, env_vars)

    @app.post("/api/executions/{exec_id}/cancel")
    def cancel_execution(exec_id: str):
        with running_lock:
            entry = running.get(exec_id)
        if entry is None:
            raise HTTPException(404, "no running execution with that id")
        entry["cancel"].set()
        logbus.emit(f"[run] cancel requested ({exec_id})")
        return {"ok": True}

    @app.post("/api/flows/{flow_id}/cancel")
    def cancel_flow_runs(flow_id: str):
        """Cancel any in-flight Run(s) of this flow (used by the Stop button)."""
        with running_lock:
            tokens = [v["cancel"] for v in running.values()
                      if v["flow_id"] == flow_id]
        for tok in tokens:
            tok.set()
        if tokens:
            logbus.emit(f"[run] cancel requested for flow {flow_id} "
                        f"({len(tokens)})")
        return {"ok": True, "cancelled": len(tokens)}

    # ---------------- flow versions (snapshots) ----------------
    @app.post("/api/flows/{flow_id}/versions")
    def snapshot_flow(flow_id: str, body: VersionCreate):
        flow = db.get_flow(flow_id)
        if flow is None:
            raise HTTPException(404, "flow not found")
        graph = body.graph if body.graph is not None else flow["graph"]
        # also persist the provided graph as the flow's current graph
        if body.graph is not None:
            db.save_graph(flow_id, body.graph)
        v = db.create_version(flow_id, graph,
                              (body.label or "").strip() or None)
        logbus.emit(f"[version] snapshot '{flow['name']}' v{v['version']}")
        return v

    @app.get("/api/flows/{flow_id}/versions")
    def list_versions(flow_id: str):
        return db.list_versions(flow_id)

    @app.get("/api/versions/{version_id}")
    def get_version(version_id: str):
        v = db.get_version(version_id)
        if v is None:
            raise HTTPException(404, "version not found")
        return v

    @app.post("/api/versions/{version_id}/run")
    async def run_version(version_id: str, body: RunBody):
        v = db.get_version(version_id)
        if v is None:
            raise HTTPException(404, "version not found")
        flow = db.get_flow(v["flow_id"])
        name = f"{flow['name'] if flow else v['flow_id']} (v{v['version']})"
        env_name, env_vars = _env_lookup(body.environment)
        return await _run_graph(v["flow_id"], name, v["graph"],
                                env_name, env_vars)

    @app.delete("/api/versions/{version_id}")
    def delete_version(version_id: str):
        if db.get_version(version_id) is None:
            raise HTTPException(404, "version not found")
        db.delete_version(version_id)
        return {"ok": True}

    # ---------------- environments ----------------
    @app.get("/api/environments")
    def list_envs():
        return db.list_environments()

    @app.post("/api/environments")
    def create_env(body: EnvBody):
        name = body.name.strip()
        if not name:
            raise HTTPException(400, "name required")
        if db.get_environment_by_name(name):
            raise HTTPException(409, "environment name already in use")
        eid = db.create_environment(name, body.vars)
        return db.get_environment(eid)

    @app.patch("/api/environments/{env_id}")
    def patch_env(env_id: str, body: EnvPatch):
        env = db.get_environment(env_id)
        if env is None:
            raise HTTPException(404, "environment not found")
        if body.name is not None:
            other = db.get_environment_by_name(body.name.strip())
            if other and other["id"] != env_id:
                raise HTTPException(409, "name already in use")
        db.update_environment(
            env_id,
            name=body.name.strip() if body.name is not None else None,
            vars_dict=body.vars)
        return db.get_environment(env_id)

    @app.delete("/api/environments/{env_id}")
    def delete_env(env_id: str):
        if db.get_environment(env_id) is None:
            raise HTTPException(404, "environment not found")
        db.delete_environment(env_id)
        return {"ok": True}

    # ---------------- executions ----------------
    @app.get("/api/executions")
    def list_execs(limit: int = 200):
        return db.list_executions(limit)

    @app.get("/api/executions/{exec_id}")
    def get_exec(exec_id: str):
        ex = db.get_execution(exec_id)
        if ex is None:
            raise HTTPException(404, "execution not found")
        ex["steps"] = db.get_steps(exec_id)
        return ex

    @app.delete("/api/executions")
    def clear_execs():
        db.clear_executions()
        return {"ok": True}

    # ---------------- listeners ----------------
    @app.get("/api/listeners")
    def get_listeners():
        return listeners.stats()

    @app.post("/api/flows/{flow_id}/listen")
    def start_listen(flow_id: str, body: RunBody):
        flow = db.get_flow(flow_id)
        if flow is None:
            raise HTTPException(404, "flow not found")
        env_name, env_vars = _env_lookup(body.environment)
        try:
            listeners.start(flow, env_name, env_vars)
        except Exception as ex:  # validation / start failure
            raise HTTPException(400, str(ex))
        return {"ok": True, "listeners": listeners.stats()}

    @app.delete("/api/listeners/{flow_id}")
    def stop_listen(flow_id: str):
        if not listeners.stop(flow_id):
            raise HTTPException(404, "flow is not listening")
        return {"ok": True, "listeners": listeners.stats()}

    @app.delete("/api/listeners")
    def stop_all_listen():
        n = listeners.stop_all()
        return {"ok": True, "stopped": n}

    # ---------------- schedules (cron) ----------------
    def _schedule_out(sched: dict) -> dict:
        out = dict(sched)
        nxt = None
        if sched.get("enabled"):
            try:
                dt = cron_next(sched["cron"])
                nxt = dt.timestamp() if dt else None
            except CronError:
                nxt = None
        out["next_run_at"] = nxt
        return out

    @app.get("/api/schedules")
    def list_schedules():
        return [_schedule_out(s) for s in db.list_schedules()]

    @app.post("/api/schedules")
    def create_schedule(body: ScheduleCreate):
        if db.get_flow(body.flow_id) is None:
            raise HTTPException(404, "flow not found")
        try:
            parse_cron(body.cron)
        except CronError as e:
            raise HTTPException(400, f"invalid cron: {e}")
        if body.environment:
            _env_lookup(body.environment)  # 404 if unknown
        sid = db.create_schedule(
            body.flow_id, body.cron.strip(), body.environment, body.enabled)
        logbus.emit(f"[cron] scheduled '{db.get_flow(body.flow_id)['name']}' "
                    f"({body.cron})", level="ok")
        return _schedule_out(db.get_schedule(sid))

    @app.patch("/api/schedules/{schedule_id}")
    def patch_schedule(schedule_id: str, body: SchedulePatch):
        if db.get_schedule(schedule_id) is None:
            raise HTTPException(404, "schedule not found")
        if body.cron is not None:
            try:
                parse_cron(body.cron)
            except CronError as e:
                raise HTTPException(400, f"invalid cron: {e}")
        if body.set_environment and body.environment:
            _env_lookup(body.environment)
        db.update_schedule(
            schedule_id,
            cron=body.cron.strip() if body.cron is not None else None,
            environment=body.environment,
            enabled=body.enabled,
            set_environment=body.set_environment)
        return _schedule_out(db.get_schedule(schedule_id))

    @app.delete("/api/schedules/{schedule_id}")
    def delete_schedule(schedule_id: str):
        if db.get_schedule(schedule_id) is None:
            raise HTTPException(404, "schedule not found")
        db.delete_schedule(schedule_id)
        return {"ok": True}

    @app.post("/api/schedules/{schedule_id}/run")
    async def run_schedule_now(schedule_id: str):
        sched = db.get_schedule(schedule_id)
        if sched is None:
            raise HTTPException(404, "schedule not found")
        exec_id, status, error = await run_in_threadpool(
            scheduler.run_now, schedule_id)
        return {"execution_id": exec_id, "status": status, "error": error}

    # ---------------- node packages ----------------
    def _pkg_list():
        return {"packages": packages.list(),
                "load_errors": [{"file": f, "error": e}
                                for f, e in registry.errors]}

    @app.get("/api/packages")
    def list_packages():
        return _pkg_list()

    @app.post("/api/packages/install_git")
    async def install_git(body: GitInstallBody):
        try:
            res = await run_in_threadpool(
                packages.install_git, body.url, body.ref)
        except PackageError as e:
            raise HTTPException(400, str(e))
        logbus.emit(f"[pkg] installed '{res['package']['name']}' (git)",
                    level="ok")
        return {**res, **_pkg_list()}

    @app.post("/api/packages/install_zip")
    async def install_zip(file: UploadFile = File(...)):
        data = await file.read()
        try:
            res = await run_in_threadpool(
                packages.install_zip, data, file.filename or "package.zip")
        except PackageError as e:
            raise HTTPException(400, str(e))
        logbus.emit(f"[pkg] installed '{res['package']['name']}' (zip)",
                    level="ok")
        return {**res, **_pkg_list()}

    @app.post("/api/packages/{name}/update")
    async def update_package(name: str):
        try:
            res = await run_in_threadpool(packages.update, name)
        except PackageError as e:
            raise HTTPException(400, str(e))
        logbus.emit(f"[pkg] updated '{name}'", level="ok")
        return {**res, **_pkg_list()}

    @app.delete("/api/packages/{name}")
    def remove_package(name: str):
        try:
            res = packages.remove(name)
        except PackageError as e:
            raise HTTPException(400, str(e))
        logbus.emit(f"[pkg] removed '{name}'")
        return {**res, **_pkg_list()}

    # ---------------- log stream ----------------
    @app.websocket("/api/logs")
    async def logs_ws(ws: WebSocket):
        await ws.accept()
        for line in logbus.history():
            await ws.send_json(line)
        q = logbus.subscribe()
        try:
            while True:
                line = await q.get()
                await ws.send_json(line)
        except WebSocketDisconnect:
            pass
        finally:
            logbus.unsubscribe(q)

    # ---------------- interactive shell (PTY) ----------------
    @app.websocket("/api/shell")
    async def shell_ws(ws: WebSocket):
        await ws.accept()
        await _serve_shell(ws)

    return app


async def _serve_shell(ws: WebSocket):
    """Bridge a WebSocket to a PTY-backed login shell.

    Protocol: client sends keystrokes as binary frames and control messages
    (window resize) as JSON text frames, e.g. {"resize": [cols, rows]}.
    The shell's output is streamed back as binary frames. Unix only.
    """
    try:
        import os
        import pty
        import signal
        import struct
        import fcntl
        import termios
    except ImportError:  # pragma: no cover - non-Unix
        await ws.send_text("Interactive shell is only supported on Unix "
                           "hosts.\r\n")
        await ws.close()
        return

    shell = os.environ.get("SHELL") or "/bin/bash"
    pid, master_fd = pty.fork()
    if pid == 0:  # child -> become the shell
        os.environ["TERM"] = "xterm-256color"
        try:
            os.execvp(shell, [shell, "-i"])
        except Exception:
            os._exit(1)

    loop = asyncio.get_running_loop()
    out_q: asyncio.Queue = asyncio.Queue()

    def _on_readable():
        try:
            data = os.read(master_fd, 65536)
        except OSError:
            data = b""
        out_q.put_nowait(data or None)  # None => EOF

    loop.add_reader(master_fd, _on_readable)

    async def _pump_out():
        while True:
            data = await out_q.get()
            if data is None:
                break
            try:
                await ws.send_bytes(data)
            except Exception:
                break

    out_task = asyncio.create_task(_pump_out())
    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            if msg.get("bytes") is not None:
                os.write(master_fd, msg["bytes"])
            elif msg.get("text") is not None:
                text = msg["text"]
                try:
                    ctrl = json.loads(text)
                    cols, rows = ctrl["resize"]
                    winsize = struct.pack("HHHH", int(rows), int(cols), 0, 0)
                    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)
                except Exception:
                    os.write(master_fd, text.encode())
    except WebSocketDisconnect:
        pass
    finally:
        try:
            loop.remove_reader(master_fd)
        except Exception:
            pass
        out_task.cancel()
        try:
            os.close(master_fd)
        except OSError:
            pass
        try:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        except Exception:
            pass

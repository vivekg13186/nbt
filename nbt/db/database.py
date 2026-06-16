"""Thread-safe SQLite persistence for flows and executions."""

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS flows (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    graph       TEXT NOT NULL DEFAULT '{"nodes": [], "links": []}',
    folder      TEXT,
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS flow_versions (
    id          TEXT PRIMARY KEY,
    flow_id     TEXT NOT NULL,
    version     INTEGER NOT NULL,
    label       TEXT,
    graph       TEXT NOT NULL,
    created_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_flow
    ON flow_versions(flow_id, version DESC);
CREATE TABLE IF NOT EXISTS environments (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    vars        TEXT NOT NULL DEFAULT '{}',
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS executions (
    id          TEXT PRIMARY KEY,
    flow_id     TEXT,
    flow_name   TEXT,
    environment TEXT,
    status      TEXT NOT NULL,            -- running | passed | failed | error
    error       TEXT,
    context     TEXT,                     -- final published context (no env)
    started_at  REAL NOT NULL,
    finished_at REAL
);
CREATE TABLE IF NOT EXISTS execution_steps (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
    node_id      TEXT,
    node_name    TEXT,
    node_type    TEXT,
    status       TEXT NOT NULL,           -- passed | failed | skipped
    error        TEXT,
    inputs       TEXT,
    outputs      TEXT,
    started_at   REAL,
    finished_at  REAL
);
CREATE INDEX IF NOT EXISTS idx_steps_exec ON execution_steps(execution_id);
CREATE INDEX IF NOT EXISTS idx_exec_started ON executions(started_at DESC);
"""


def _row_to_dict(row):
    return dict(row) if row is not None else None


class Database:
    def __init__(self, path):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = self._connect()
        with self._lock:
            try:
                self._conn.execute("PRAGMA journal_mode=WAL")
                self._conn.executescript(SCHEMA)
            except sqlite3.OperationalError:
                # WAL is unsupported on some filesystems (network mounts);
                # fall back to the default rollback journal.
                self._conn.close()
                self._conn = self._connect()
                self._conn.execute("PRAGMA journal_mode=DELETE")
                self._conn.executescript(SCHEMA)
            self._conn.execute("PRAGMA foreign_keys=ON")
            try:  # migration for databases created before environments
                self._conn.execute(
                    "ALTER TABLE executions ADD COLUMN environment TEXT")
            except sqlite3.OperationalError:
                pass  # column already exists
            try:  # migration for databases created before flow folders
                self._conn.execute(
                    "ALTER TABLE flows ADD COLUMN folder TEXT")
            except sqlite3.OperationalError:
                pass  # column already exists
            try:  # migration for execution context snapshots
                self._conn.execute(
                    "ALTER TABLE executions ADD COLUMN context TEXT")
            except sqlite3.OperationalError:
                pass  # column already exists
            self._conn.commit()

    def _connect(self):
        conn = sqlite3.connect(self.path, check_same_thread=False,
                               timeout=10.0)
        conn.row_factory = sqlite3.Row
        return conn

    def close(self):
        with self._lock:
            self._conn.close()

    def _exec(self, sql, params=()):
        with self._lock:
            cur = self._conn.execute(sql, params)
            self._conn.commit()
            return cur

    def _query(self, sql, params=()):
        with self._lock:
            return [_row_to_dict(r)
                    for r in self._conn.execute(sql, params).fetchall()]

    # ---------------- flows (CRUD) ----------------

    def create_flow(self, name, graph=None, folder=None):
        fid = uuid.uuid4().hex[:12]
        now = time.time()
        graph_json = json.dumps(graph or {"nodes": [], "links": []})
        self._exec(
            "INSERT INTO flows (id, name, graph, folder, created_at, "
            "updated_at) VALUES (?,?,?,?,?,?)",
            (fid, name, graph_json, folder or None, now, now))
        return fid

    def list_flows(self):
        return self._query(
            "SELECT id, name, folder, created_at, updated_at FROM flows "
            "ORDER BY name COLLATE NOCASE")

    def set_flow_folder(self, flow_id, folder):
        self._exec("UPDATE flows SET folder=?, updated_at=? WHERE id=?",
                   (folder or None, time.time(), flow_id))

    def get_flow(self, flow_id):
        rows = self._query("SELECT * FROM flows WHERE id=?", (flow_id,))
        if not rows:
            return None
        flow = rows[0]
        flow["graph"] = json.loads(flow["graph"] or "{}")
        return flow

    def get_flow_by_name(self, name):
        rows = self._query("SELECT id FROM flows WHERE name=?", (name,))
        return self.get_flow(rows[0]["id"]) if rows else None

    def rename_flow(self, flow_id, new_name):
        self._exec("UPDATE flows SET name=?, updated_at=? WHERE id=?",
                   (new_name, time.time(), flow_id))

    def save_graph(self, flow_id, graph):
        self._exec("UPDATE flows SET graph=?, updated_at=? WHERE id=?",
                   (json.dumps(graph), time.time(), flow_id))

    def duplicate_flow(self, flow_id, new_name):
        flow = self.get_flow(flow_id)
        if flow is None:
            return None
        return self.create_flow(new_name, flow["graph"],
                                flow.get("folder"))

    def delete_flow(self, flow_id):
        self._exec("DELETE FROM flows WHERE id=?", (flow_id,))
        self._exec("DELETE FROM flow_versions WHERE flow_id=?", (flow_id,))

    # ---------------- flow versions (snapshots) ----------------

    def create_version(self, flow_id, graph, label=None):
        vid = uuid.uuid4().hex[:12]
        rows = self._query(
            "SELECT COALESCE(MAX(version), 0) AS m FROM flow_versions "
            "WHERE flow_id=?", (flow_id,))
        version = (rows[0]["m"] if rows else 0) + 1
        self._exec(
            "INSERT INTO flow_versions (id, flow_id, version, label, graph, "
            "created_at) VALUES (?,?,?,?,?,?)",
            (vid, flow_id, version, label or None, json.dumps(graph),
             time.time()))
        return self.get_version(vid)

    def list_versions(self, flow_id):
        return self._query(
            "SELECT id, flow_id, version, label, created_at FROM "
            "flow_versions WHERE flow_id=? ORDER BY version DESC", (flow_id,))

    def get_version(self, version_id):
        rows = self._query(
            "SELECT * FROM flow_versions WHERE id=?", (version_id,))
        if not rows:
            return None
        rows[0]["graph"] = json.loads(rows[0]["graph"] or "{}")
        return rows[0]

    def delete_version(self, version_id):
        self._exec("DELETE FROM flow_versions WHERE id=?", (version_id,))

    # ---------------- environments (CRUD) ----------------

    def create_environment(self, name, vars_dict=None):
        eid = uuid.uuid4().hex[:12]
        now = time.time()
        self._exec(
            "INSERT INTO environments (id, name, vars, created_at, "
            "updated_at) VALUES (?,?,?,?,?)",
            (eid, name, json.dumps(vars_dict or {}), now, now))
        return eid

    def list_environments(self):
        rows = self._query(
            "SELECT * FROM environments ORDER BY name COLLATE NOCASE")
        for r in rows:
            r["vars"] = json.loads(r["vars"] or "{}")
        return rows

    def get_environment(self, env_id):
        rows = self._query("SELECT * FROM environments WHERE id=?", (env_id,))
        if not rows:
            return None
        rows[0]["vars"] = json.loads(rows[0]["vars"] or "{}")
        return rows[0]

    def get_environment_by_name(self, name):
        rows = self._query("SELECT id FROM environments WHERE name=?", (name,))
        return self.get_environment(rows[0]["id"]) if rows else None

    def update_environment(self, env_id, name=None, vars_dict=None):
        env = self.get_environment(env_id)
        if env is None:
            return
        self._exec(
            "UPDATE environments SET name=?, vars=?, updated_at=? WHERE id=?",
            (name if name is not None else env["name"],
             json.dumps(vars_dict if vars_dict is not None else env["vars"]),
             time.time(), env_id))

    def delete_environment(self, env_id):
        self._exec("DELETE FROM environments WHERE id=?", (env_id,))

    # ---------------- executions ----------------

    def create_execution(self, flow_id, flow_name, environment=None):
        eid = uuid.uuid4().hex[:12]
        self._exec(
            "INSERT INTO executions (id, flow_id, flow_name, environment, "
            "status, started_at) VALUES (?,?,?,?,?,?)",
            (eid, flow_id, flow_name, environment, "running", time.time()))
        return eid

    def finish_execution(self, exec_id, status, error, context=None):
        self._exec(
            "UPDATE executions SET status=?, error=?, context=?, "
            "finished_at=? WHERE id=?",
            (status, error,
             None if context is None else json.dumps(context, default=repr),
             time.time(), exec_id))

    def list_executions(self, limit=200):
        return self._query(
            "SELECT * FROM executions ORDER BY started_at DESC LIMIT ?",
            (limit,))

    def get_execution(self, exec_id):
        rows = self._query("SELECT * FROM executions WHERE id=?", (exec_id,))
        if not rows:
            return None
        ctx = rows[0].get("context")
        rows[0]["context"] = json.loads(ctx) if ctx else None
        return rows[0]

    def clear_executions(self):
        self._exec("DELETE FROM execution_steps")
        self._exec("DELETE FROM executions")

    def add_step(self, exec_id, node_id, node_name, node_type, status,
                 error, inputs_json, outputs_json, started_at, finished_at):
        self._exec(
            "INSERT INTO execution_steps (execution_id, node_id, node_name, "
            "node_type, status, error, inputs, outputs, started_at, "
            "finished_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (exec_id, node_id, node_name, node_type, status, error,
             inputs_json, outputs_json, started_at, finished_at))

    def get_steps(self, exec_id):
        return self._query(
            "SELECT * FROM execution_steps WHERE execution_id=? ORDER BY id",
            (exec_id,))

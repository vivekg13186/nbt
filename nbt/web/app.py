"""NiceGUI web front-end: LiteGraph.js editor over the same core + SQLite.

Single-user / internal use. Reuses nbt.core (engine, registry, listener)
and nbt.db unchanged; only the presentation layer differs from the
desktop (DearPyGui) app.
"""

import asyncio
import datetime
import json
from pathlib import Path

from nicegui import app as nicegui_app
from nicegui import run as nicegui_run
from nicegui import ui

from ..core.engine import Engine
from ..core.listener import FlowListener

JS_PATH = Path(__file__).with_name("litegraph_embed.js")
STATIC_DIR = Path(__file__).with_name("static")  # vendored LiteGraph (MIT)
LITEGRAPH_CSS = "/nbt-static/litegraph.css"
LITEGRAPH_JS = "/nbt-static/litegraph.core.min.js"

EXEC_COLUMNS = [
    {"name": "started", "label": "Started", "field": "started",
     "sortable": True, "align": "left"},
    {"name": "id", "label": "Run ID", "field": "id", "sortable": True,
     "align": "left"},
    {"name": "flow", "label": "Flow", "field": "flow", "sortable": True,
     "align": "left"},
    {"name": "env", "label": "Env", "field": "env", "sortable": True,
     "align": "left"},
    {"name": "status", "label": "Status", "field": "status",
     "sortable": True, "align": "left"},
    {"name": "duration", "label": "Duration", "field": "duration",
     "sortable": True, "align": "left"},
    {"name": "error", "label": "Error", "field": "error", "sortable": True,
     "align": "left"},
]

STEP_COLUMNS = [
    {"name": "node", "label": "Node", "field": "node", "align": "left"},
    {"name": "type", "label": "Type", "field": "type", "align": "left"},
    {"name": "status", "label": "Status", "field": "status", "align": "left"},
    {"name": "duration", "label": "Duration", "field": "duration",
     "align": "left"},
]


def _ts(t):
    if not t:
        return "-"
    return datetime.datetime.fromtimestamp(t).strftime("%Y-%m-%d %H:%M:%S")


def _dur(a, b):
    if not a or not b:
        return "-"
    return f"{b - a:.2f}s"


class WebApp:
    def __init__(self, db, registry):
        self.db = db
        self.registry = registry
        self.engine = Engine(registry, db)
        self.current_flow_id = None
        self.listeners = {}      # flow_id -> FlowListener
        self._loading = False    # suppress select on_change during refresh

    # ---------------- metadata for the JS side ----------------

    def node_metas(self):
        metas = []
        for tname, cls in sorted(self.registry.types.items()):
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
            })
        return metas

    # ---------------- JS bridge ----------------

    async def _js_ready(self):
        for _ in range(20):
            try:
                ok = await ui.run_javascript(
                    "!!(window.nbt && window.nbt.importGraph)", timeout=3)
                if ok:
                    return True
            except Exception:
                pass
            await asyncio.sleep(0.3)
        return False

    async def export_graph(self):
        data = await ui.run_javascript("window.nbt.exportGraph()", timeout=5)
        return data or {"nodes": [], "links": []}

    async def import_graph(self, graph):
        await ui.run_javascript(
            f"window.nbt.importGraph({json.dumps(graph)})", timeout=5)

    # ---------------- flows ----------------

    def _flow_options(self):
        return {f["id"]: f["name"] for f in self.db.list_flows()}

    def refresh_flow_select(self):
        self._loading = True
        self.flow_select.options = self._flow_options()
        self.flow_select.value = self.current_flow_id
        self.flow_select.update()
        self._loading = False

    async def load_flow(self, flow_id):
        flow = self.db.get_flow(flow_id)
        if flow is None:
            return
        self.current_flow_id = flow_id
        await self.import_graph(flow["graph"])
        self._update_listen_ui()

    async def on_flow_change(self, e):
        if self._loading or not e.value or e.value == self.current_flow_id:
            return
        if self.current_flow_id:
            await self.save_current(notify=False)
        await self.load_flow(e.value)

    async def save_current(self, notify=True):
        if not self.current_flow_id:
            if notify:
                ui.notify("No flow open.", type="warning")
            return False
        try:
            graph = await self.export_graph()
            self.db.save_graph(self.current_flow_id, graph)
            if notify:
                ui.notify("Flow saved.", type="positive")
            return True
        except Exception as ex:
            ui.notify(f"Save failed: {ex}", type="negative")
            return False

    async def on_new_flow(self):
        name = (self.new_flow_name.value or "").strip()
        self.new_flow_dialog.close()
        if not name:
            return
        if name in self._flow_options().values():
            ui.notify(f"A flow named '{name}' exists.", type="warning")
            return
        if self.current_flow_id:
            await self.save_current(notify=False)
        fid = self.db.create_flow(name)
        await self.load_flow(fid)
        self.refresh_flow_select()

    async def on_rename_flow(self):
        name = (self.rename_flow_name.value or "").strip()
        self.rename_flow_dialog.close()
        if not name or not self.current_flow_id:
            return
        if name in self._flow_options().values():
            ui.notify(f"A flow named '{name}' exists.", type="warning")
            return
        self.db.rename_flow(self.current_flow_id, name)
        if self.current_flow_id in self.listeners:
            self.listeners[self.current_flow_id].flow["name"] = name
        self.refresh_flow_select()

    async def on_duplicate_flow(self):
        if not self.current_flow_id:
            return
        await self.save_current(notify=False)
        flow = self.db.get_flow(self.current_flow_id)
        base, name, i = f"{flow['name']} copy", f"{flow['name']} copy", 2
        names = set(self._flow_options().values())
        while name in names:
            name, i = f"{base} {i}", i + 1
        fid = self.db.duplicate_flow(self.current_flow_id, name)
        await self.load_flow(fid)
        self.refresh_flow_select()

    async def on_delete_flow(self):
        self.delete_flow_dialog.close()
        if not self.current_flow_id:
            return
        self.stop_listening(self.current_flow_id, quiet=True)
        self.db.delete_flow(self.current_flow_id)
        self.current_flow_id = None
        await self.import_graph({"nodes": [], "links": []})
        flows = self.db.list_flows()
        if flows:
            await self.load_flow(flows[0]["id"])
        self.refresh_flow_select()

    # ---------------- environments ----------------

    def _env_names(self):
        return [e["name"] for e in self.db.list_environments()]

    def refresh_env_select(self):
        names = ["(none)"] + self._env_names()
        self.env_select.options = names
        if self.env_select.value not in names:
            self.env_select.value = "(none)"
        self.env_select.update()
        self.env_list.options = self._env_names()
        self.env_list.update()

    def _selected_env(self):
        sel = self.env_select.value
        if not sel or sel == "(none)":
            return True, None, None
        env = self.db.get_environment_by_name(sel)
        if env is None:
            ui.notify(f"Environment '{sel}' no longer exists.",
                      type="negative")
            self.refresh_env_select()
            return False, None, None
        return True, env["name"], env["vars"]

    def on_env_pick(self, e):
        env = self.db.get_environment_by_name(e.value or "")
        if env:
            self.env_name_input.value = env["name"]
            self.env_vars_input.value = json.dumps(env["vars"], indent=2)

    def on_env_save(self):
        name = (self.env_name_input.value or "").strip()
        if not name:
            ui.notify("Name is required.", type="warning")
            return
        raw = (self.env_vars_input.value or "").strip() or "{}"
        try:
            vars_dict = json.loads(raw)
            if not isinstance(vars_dict, dict):
                raise ValueError("must be a JSON object {...}")
        except Exception as ex:
            ui.notify(f"Invalid JSON: {ex}", type="negative")
            return
        existing = self.db.get_environment_by_name(name)
        if existing:
            self.db.update_environment(existing["id"], vars_dict=vars_dict)
        else:
            self.db.create_environment(name, vars_dict)
        self.refresh_env_select()
        ui.notify(f"Saved '{name}'.", type="positive")

    def on_env_delete(self):
        env = self.db.get_environment_by_name(self.env_list.value or "")
        if env is None:
            ui.notify("Select an environment first.", type="warning")
            return
        self.db.delete_environment(env["id"])
        self.refresh_env_select()
        self.env_name_input.value = ""
        self.env_vars_input.value = ""

    # ---------------- run / listen ----------------

    async def on_run(self):
        if not self.current_flow_id:
            ui.notify("Open a flow first.", type="warning")
            return
        if not await self.save_current(notify=False):
            return
        ok, env_name, env_vars = self._selected_env()
        if not ok:
            return
        flow = self.db.get_flow(self.current_flow_id)
        self.run_btn.disable()
        try:
            exec_id, status, error = await nicegui_run.io_bound(
                self.engine.execute, flow["id"], flow["name"], flow["graph"],
                env_name, env_vars)
        finally:
            self.run_btn.enable()
        kind = "positive" if status == "passed" else "negative"
        msg = f"Run {status.upper()}"
        if error:
            msg += f" - {error.splitlines()[0][:140]}"
        ui.notify(msg, type=kind, timeout=6000)
        self.refresh_executions()
        self.show_steps(exec_id)

    async def on_listen(self):
        fid = self.current_flow_id
        if not fid:
            ui.notify("Open a flow first.", type="warning")
            return
        if fid in self.listeners:
            self.stop_listening(fid)
            return
        if not await self.save_current(notify=False):
            return
        ok, env_name, env_vars = self._selected_env()
        if not ok:
            return
        flow = self.db.get_flow(fid)
        listener = FlowListener(self.engine, flow, env_name, env_vars)
        try:
            listener.start()  # stats are polled by the page timer
        except Exception as ex:
            ui.notify(f"Cannot listen: {ex}", type="negative")
            return
        self.listeners[fid] = listener
        self._update_listen_ui()
        ui.notify(f"Listening on '{flow['name']}'.", type="info")

    def stop_listening(self, flow_id=None, quiet=False):
        ids = [flow_id] if flow_id is not None else list(self.listeners)
        stopped = []
        for fid in ids:
            lst = self.listeners.pop(fid, None)
            if lst is not None:
                lst.stop()
                stopped.append(lst.flow["name"])
        self._update_listen_ui()
        if stopped and not quiet:
            ui.notify("Stopped listening: " + ", ".join(stopped))

    def _update_listen_ui(self):
        listening_here = self.current_flow_id in self.listeners
        self.listen_btn.text = ("Stop listening" if listening_here
                                else "Listen")
        self.listeners_btn.text = f"Listeners: {len(self.listeners)}"
        self.listen_btn.update()
        self.listeners_btn.update()
        self._render_listener_rows()

    def _render_listener_rows(self):
        self.listener_box.clear()
        with self.listener_box:
            if not self.listeners:
                ui.label("No active listeners.").classes("text-grey")
                return
            for fid, lst in list(self.listeners.items()):
                status = (lst.last_result or (None, "-", None))[1]
                with ui.row().classes("items-center gap-2"):
                    ui.button("Stop",
                              on_click=lambda fid=fid: self.stop_listening(fid)
                              ).props("dense size=sm color=negative")
                    env = f" [{lst.environment}]" if lst.environment else ""
                    ui.label(f"{lst.flow['name']}{env}").classes("font-bold")
                    ui.label(
                        f"events:{lst.events} runs:{lst.runs} "
                        f"filtered:{lst.filtered} busy:{lst.skipped_busy} "
                        f"last:{status}").classes("text-grey")

    def _tick(self):
        """Periodic refresh while listeners are active."""
        if self.listeners:
            self.refresh_executions()
            self._update_listen_ui()

    # ---------------- executions ----------------

    def _exec_rows(self):
        rows = []
        for ex in self.db.list_executions():
            rows.append({
                "started": _ts(ex["started_at"]),
                "id": ex["id"],
                "flow": ex["flow_name"] or "?",
                "env": ex.get("environment") or "-",
                "status": ex["status"],
                "duration": _dur(ex["started_at"], ex["finished_at"]),
                "error": ((ex["error"] or "").splitlines() or [""])[0][:90],
            })
        return rows

    def refresh_executions(self):
        self.exec_table.rows = self._exec_rows()
        self.exec_table.update()

    def on_clear_executions(self):
        self.db.clear_executions()
        self.refresh_executions()

    def show_steps(self, exec_id):
        ex = self.db.get_execution(exec_id)
        if ex is None:
            return
        self.steps_header.text = (
            f"Run {ex['id']} at {_ts(ex['started_at'])} "
            f"({ex['flow_name']}, {ex['status']})")
        self._step_details = {}
        rows = []
        for st in self.db.get_steps(exec_id):
            key = str(st["id"])
            rows.append({
                "key": key,
                "node": st["node_name"] or "?",
                "type": st["node_type"] or "?",
                "status": st["status"],
                "duration": _dur(st["started_at"], st["finished_at"]),
            })
            self._step_details[key] = (
                f"node:    {st['node_name']} ({st['node_type']})\n"
                f"status:  {st['status']}\n"
                f"inputs:  {st['inputs']}\n"
                f"outputs: {st['outputs']}\n"
                + (f"error:\n{st['error']}" if st["error"] else ""))
        self.steps_table.rows = rows
        self.steps_table.update()
        self.step_detail.value = "(click a step)"
        self.steps_dialog.open()

    # ---------------- page ----------------

    def build(self):
        metas = self.node_metas()
        nicegui_app.add_static_files("/nbt-static", str(STATIC_DIR))
        ui.add_head_html(f'<link rel="stylesheet" href="{LITEGRAPH_CSS}">')
        ui.add_head_html(f'<script src="{LITEGRAPH_JS}"></script>')
        js = JS_PATH.read_text().replace("__METAS__", json.dumps(metas))
        ui.add_body_html(f"<script>{js}</script>")
        ui.dark_mode().enable()

        # desktop-style density: kill the web-app whitespace
        ui.add_head_html("""<style>
            .nicegui-content { padding: 6px; }
            .nicegui-column { gap: 4px; }
            .nicegui-row { gap: 4px; }
            .q-header { padding: 2px 6px; min-height: 0; }
            .q-btn { text-transform: none; padding: 2px 8px; min-height: 24px; }
            .q-table th, .q-table td { padding: 2px 8px !important;
                                       height: 24px !important; }
            .q-table__bottom { min-height: 28px; padding: 0 8px; }
            .q-field--auto-height .q-field__control,
            .q-field__control, .q-field__marginal { min-height: 30px;
                                                    height: 30px; }
            .q-card { padding: 8px; }
            .q-dialog .q-card { gap: 4px; }
            aside .q-btn { justify-content: flex-start; min-height: 22px;
                           font-size: 12px; }
        </style>""")

        # ----- header -----
        with ui.header().classes("items-center gap-1"):
            ui.label("NBT").classes("text-lg font-bold mr-2")
            self.flow_select = ui.select(
                self._flow_options(), label="Flow",
                on_change=self.on_flow_change).classes("w-52").props(
                "dense outlined")
            ui.button("New", on_click=lambda: self.new_flow_dialog.open()
                      ).props("dense")
            ui.button("Rename",
                      on_click=lambda: self.rename_flow_dialog.open()
                      ).props("dense")
            ui.button("Dup", on_click=self.on_duplicate_flow).props("dense")
            ui.button("Del", on_click=lambda: self.delete_flow_dialog.open()
                      ).props("dense color=negative")
            ui.space()
            self.env_select = ui.select(
                ["(none)"] + self._env_names(), value="(none)",
                label="Env").classes("w-36").props("dense outlined")
            ui.button("Envs", on_click=lambda: self.env_dialog.open()
                      ).props("dense")
            ui.button("Save", on_click=self.save_current).props("dense")
            self.run_btn = ui.button("Run", on_click=self.on_run
                                     ).props("dense color=positive")
            self.listen_btn = ui.button("Listen", on_click=self.on_listen
                                        ).props("dense color=orange")
            self.listeners_btn = ui.button(
                "Listeners: 0",
                on_click=lambda: (self._render_listener_rows(),
                                  self.listeners_dialog.open())
            ).props("dense flat")

        # ----- left drawer: palette -----
        with ui.left_drawer(bordered=True).classes("p-1").props(
                "width=200") as self.drawer:
            ui.label("Add node").classes("font-bold")
            cats = {}
            for m in metas:
                cats.setdefault(m["category"], []).append(m)
            for cat, items in sorted(cats.items()):
                ui.label(cat).classes("text-grey text-xs mt-1")
                for m in items:
                    label = m["label"] + (" ⚡" if m["is_trigger"] else "")
                    ui.button(
                        label,
                        on_click=lambda m=m: ui.run_javascript(
                            f'window.nbt.addNode({json.dumps(m["type"])})')
                    ).props("dense flat align=left").classes("w-full")
            if self.registry.errors:
                ui.label("Load errors").classes("text-negative mt-4")
                for fname, err in self.registry.errors:
                    ui.label(f"{fname}: {err}").classes(
                        "text-negative text-xs")

        # ----- main: canvas + executions -----
        with ui.column().classes("w-full"):
            ui.html('<canvas id="nbt-canvas" style="display:block"></canvas>'
                    ).classes("w-full").style(
                "height: 60vh; border: 1px solid #444; border-radius: 4px;")
            with ui.row().classes("items-center w-full gap-1"):
                ui.label("Executions").classes("font-bold")
                ui.button("Refresh", on_click=self.refresh_executions
                          ).props("dense flat")
                ui.button("Clear history", on_click=self.on_clear_executions
                          ).props("dense flat color=negative")
            self.exec_table = ui.table(
                columns=EXEC_COLUMNS, rows=self._exec_rows(), row_key="id",
                pagination=10).classes("w-full").props("dense flat bordered")
            self.exec_table.on(
                "rowClick", lambda e: self.show_steps(e.args[1]["id"]))

        # ----- dialogs -----
        with ui.dialog() as self.new_flow_dialog, ui.card():
            ui.label("New flow")
            self.new_flow_name = ui.input("name").classes("w-64")
            with ui.row():
                ui.button("Create", on_click=self.on_new_flow)
                ui.button("Cancel",
                          on_click=self.new_flow_dialog.close).props("flat")

        with ui.dialog() as self.rename_flow_dialog, ui.card():
            ui.label("Rename flow")
            self.rename_flow_name = ui.input("new name").classes("w-64")
            with ui.row():
                ui.button("Rename", on_click=self.on_rename_flow)
                ui.button("Cancel",
                          on_click=self.rename_flow_dialog.close
                          ).props("flat")

        with ui.dialog() as self.delete_flow_dialog, ui.card():
            ui.label("Delete the current flow? This cannot be undone.")
            with ui.row():
                ui.button("Delete", on_click=self.on_delete_flow
                          ).props("color=negative")
                ui.button("Cancel",
                          on_click=self.delete_flow_dialog.close
                          ).props("flat")

        with ui.dialog() as self.env_dialog, ui.card().classes("w-[480px]"):
            ui.label("Environments").classes("text-lg font-bold")
            self.env_list = ui.select(self._env_names(), label="existing",
                                      on_change=self.on_env_pick
                                      ).classes("w-full")
            self.env_name_input = ui.input("name").classes("w-full")
            self.env_vars_input = ui.textarea(
                "variables (JSON object)",
                placeholder='{"base_url": "https://staging.example.com"}'
            ).classes("w-full").props("rows=6")
            with ui.row():
                ui.button("New", on_click=lambda: (
                    self.env_name_input.set_value(""),
                    self.env_vars_input.set_value('{\n  "base_url": ""\n}')))
                ui.button("Save", on_click=self.on_env_save)
                ui.button("Delete", on_click=self.on_env_delete
                          ).props("color=negative")
                ui.button("Close", on_click=self.env_dialog.close
                          ).props("flat")

        with ui.dialog() as self.listeners_dialog, \
                ui.card().classes("w-[560px]"):
            ui.label("Active listeners").classes("text-lg font-bold")
            self.listener_box = ui.column().classes("w-full")
            with ui.row():
                ui.button("Stop all", on_click=lambda: self.stop_listening()
                          ).props("color=negative")
                ui.button("Close", on_click=self.listeners_dialog.close
                          ).props("flat")

        with ui.dialog() as self.steps_dialog, \
                ui.card().classes("w-[760px]"):
            self.steps_header = ui.label("Steps").classes("font-bold")
            self.steps_table = ui.table(
                columns=STEP_COLUMNS, rows=[], row_key="key",
                pagination=6).classes("w-full").props("dense")
            self.steps_table.on(
                "rowClick",
                lambda e: self.step_detail.set_value(
                    self._step_details.get(e.args[1]["key"], "")))
            self.step_detail = ui.textarea("step detail").classes(
                "w-full").props("readonly rows=8")
            ui.button("Close", on_click=self.steps_dialog.close
                      ).props("flat")

        self._step_details = {}
        ui.timer(2.0, self._tick)
        ui.timer(0.8, self._initial_load, once=True)

    async def _initial_load(self):
        if not await self._js_ready():
            ui.notify("Editor failed to load (check the browser console).",
                      type="negative")
            return
        flows = self.db.list_flows()
        if flows and not self.current_flow_id:
            await self.load_flow(flows[0]["id"])
            self.refresh_flow_select()

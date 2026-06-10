"""DearPyGui application: node editor, flows panel (CRUD), executions panel."""

import datetime
import threading
import traceback
from pathlib import Path

import dearpygui.dearpygui as dpg

from ..core.engine import Engine

COL_PASS = (80, 200, 120)
COL_FAIL = (235, 90, 90)
COL_SKIP = (200, 200, 90)
COL_RUN = (120, 170, 235)
COL_MUTED = (150, 150, 150)

STATUS_COLORS = {
    "passed": COL_PASS, "failed": COL_FAIL, "error": COL_FAIL,
    "skipped": COL_SKIP, "running": COL_RUN,
}

FONT_SIZE = 17
# First match wins. Drop a .ttf/.otf into assets/fonts/ to override.
_FONT_DIR = Path(__file__).resolve().parents[2] / "assets" / "fonts"
FONT_CANDIDATES = [
    # macOS
    "/System/Library/Fonts/Supplemental/Verdana.ttf",
    "/System/Library/Fonts/Supplemental/Tahoma.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    # Windows
    "C:/Windows/Fonts/segoeui.ttf",
    "C:/Windows/Fonts/verdana.ttf",
    # Linux
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/ubuntu/Ubuntu-R.ttf",
]


def _ts(t):
    if not t:
        return "-"
    return datetime.datetime.fromtimestamp(t).strftime("%Y-%m-%d %H:%M:%S")


def _dur(a, b):
    if not a or not b:
        return "-"
    return f"{b - a:.2f}s"


class App:
    def __init__(self, db, registry):
        self.db = db
        self.registry = registry
        self.engine = Engine(registry, db)

        self.current_flow_id = None
        self.nodes = {}        # node_id -> type_name
        self.raw_params = {}   # node_id -> params loaded from db (fallback)
        self.links = {}        # dpg link item id -> (src_node_id, dst_node_id)
        self._id_counter = 0
        self._spawn_offset = 0
        self._running = False
        self.flow_name_to_id = {}
        self._zoom = 1.0

    # ================= helpers =================

    def _new_id(self):
        existing = set(self.nodes)
        while True:
            self._id_counter += 1
            nid = f"n{self._id_counter}"
            if nid not in existing:
                return nid

    def set_status(self, text, color=None):
        dpg.set_value("status_text", text)
        dpg.configure_item("status_text", color=color or (255, 255, 255))

    # ================= zoom (pseudo: font scale + reposition) =================

    def set_zoom(self, factor):
        factor = max(0.5, min(1.6, round(factor, 2)))
        ratio = factor / self._zoom
        if abs(ratio - 1.0) > 1e-6:
            for nid in self.nodes:
                x, y = dpg.get_item_pos(f"gnode_{nid}")
                dpg.set_item_pos(f"gnode_{nid}", [x * ratio, y * ratio])
        self._zoom = factor
        dpg.set_global_font_scale(factor)
        dpg.set_value("zoom_text", f"{int(factor * 100)}%")

    def zoom_in(self):
        self.set_zoom(self._zoom + 0.1)

    def zoom_out(self):
        self.set_zoom(self._zoom - 0.1)

    # ================= node editor =================

    def add_node(self, type_name, node_data=None):
        cls = self.registry.get(type_name)
        nd = node_data or {}
        nid = nd.get("id") or self._new_id()
        if nd.get("id"):
            try:
                self._id_counter = max(self._id_counter,
                                       int(str(nid).lstrip("n") or 0))
            except ValueError:
                pass
        pos = nd.get("pos")
        if not pos:
            self._spawn_offset = (self._spawn_offset + 1) % 8
            pos = [60 + self._spawn_offset * 40, 60 + self._spawn_offset * 40]
        pos = [p * self._zoom for p in pos]  # stored positions are at 100%

        label = cls.label if cls else f"{type_name} (missing!)"
        with dpg.node(label=label, tag=f"gnode_{nid}", parent="editor",
                      pos=pos):
            with dpg.node_attribute(tag=f"attr_in_{nid}",
                                    attribute_type=dpg.mvNode_Attr_Input):
                dpg.add_text("in", color=COL_MUTED)
            with dpg.node_attribute(attribute_type=dpg.mvNode_Attr_Static):
                dpg.add_input_text(
                    label="name", tag=f"w_{nid}_name", width=170,
                    default_value=nd.get("name") or f"{type_name}_{nid}")
                if cls:
                    params = nd.get("params", {})
                    for pname, default in cls.inputs.items():
                        tag = f"w_{nid}_p_{pname}"
                        val = params.get(pname, default)
                        if isinstance(default, bool):
                            dpg.add_checkbox(label=pname, tag=tag,
                                             default_value=bool(val))
                        elif isinstance(default, int):
                            dpg.add_input_int(label=pname, tag=tag, width=170,
                                              default_value=int(val))
                        elif isinstance(default, float):
                            dpg.add_input_float(label=pname, tag=tag,
                                                width=170,
                                                default_value=float(val))
                        else:
                            dpg.add_input_text(label=pname, tag=tag,
                                               width=170,
                                               default_value=str(val))
                else:
                    dpg.add_text("node type not found in nodes/",
                                 color=COL_FAIL)
                dpg.add_input_text(
                    label="condition", tag=f"w_{nid}_cond", width=170,
                    hint="falsy -> skip node",
                    default_value=nd.get("condition", ""))
                dpg.add_input_text(
                    label="assert", tag=f"w_{nid}_assert", width=170,
                    hint="falsy -> fail node",
                    default_value=nd.get("assert", ""))
            with dpg.node_attribute(tag=f"attr_out_{nid}",
                                    attribute_type=dpg.mvNode_Attr_Output):
                dpg.add_text("out", color=COL_MUTED)

        self.nodes[nid] = type_name
        self.raw_params[nid] = dict(nd.get("params", {}))
        return nid

    def _attr_node(self, attr_item):
        """attr item/alias -> (node_id, kind) where kind is 'in'/'out'."""
        alias = dpg.get_item_alias(attr_item) or str(attr_item)
        if alias.startswith("attr_in_"):
            return alias[len("attr_in_"):], "in"
        if alias.startswith("attr_out_"):
            return alias[len("attr_out_"):], "out"
        return None, None

    def on_link(self, sender, app_data):
        a1, a2 = app_data
        n1, k1 = self._attr_node(a1)
        n2, k2 = self._attr_node(a2)
        if None in (n1, n2):
            return
        if k1 != "out":  # normalize direction: a1 must be the output side
            a1, a2, n1, n2 = a2, a1, n2, n1
        if n1 == n2:
            return
        # keep the chain linear: one outgoing per source, one incoming per dest
        for link_id, (src, dst) in list(self.links.items()):
            if src == n1 or dst == n2:
                dpg.delete_item(link_id)
                del self.links[link_id]
        link_id = dpg.add_node_link(a1, a2, parent=sender)
        self.links[link_id] = (n1, n2)

    def on_delink(self, sender, app_data):
        self.links.pop(app_data, None)
        dpg.delete_item(app_data)

    def delete_selected(self):
        for link_id in dpg.get_selected_links("editor"):
            self.links.pop(link_id, None)
            dpg.delete_item(link_id)
        for item in dpg.get_selected_nodes("editor"):
            alias = dpg.get_item_alias(item) or ""
            if not alias.startswith("gnode_"):
                continue
            nid = alias[len("gnode_"):]
            for link_id, (src, dst) in list(self.links.items()):
                if nid in (src, dst):
                    dpg.delete_item(link_id)
                    del self.links[link_id]
            dpg.delete_item(alias)
            self.nodes.pop(nid, None)
            self.raw_params.pop(nid, None)

    def clear_editor(self):
        dpg.delete_item("editor", children_only=True)
        self.nodes.clear()
        self.links.clear()
        self.raw_params.clear()

    # ================= serialize / load =================

    def serialize(self):
        nodes = []
        for nid, tname in self.nodes.items():
            cls = self.registry.get(tname)
            params = dict(self.raw_params.get(nid, {}))
            for pname in (cls.inputs if cls else {}):
                tag = f"w_{nid}_p_{pname}"
                if dpg.does_item_exist(tag):
                    params[pname] = dpg.get_value(tag)
            nodes.append({
                "id": nid,
                "type": tname,
                "name": (dpg.get_value(f"w_{nid}_name") or nid).strip(),
                "condition": dpg.get_value(f"w_{nid}_cond") or "",
                "assert": dpg.get_value(f"w_{nid}_assert") or "",
                "params": params,
                "pos": [int(p / self._zoom)
                        for p in dpg.get_item_pos(f"gnode_{nid}")],
            })
        links = [[src, dst] for src, dst in self.links.values()]
        return {"nodes": nodes, "links": links}

    def load_graph(self, graph):
        self.clear_editor()
        graph = graph or {}
        for nd in graph.get("nodes", []):
            self.add_node(nd.get("type", "?"), nd)
        for link in graph.get("links", []):
            src, dst = link[0], link[1]
            if src in self.nodes and dst in self.nodes:
                link_id = dpg.add_node_link(
                    f"attr_out_{src}", f"attr_in_{dst}", parent="editor")
                self.links[link_id] = (src, dst)

    # ================= flows panel (CRUD) =================

    def refresh_flow_list(self, select_name=None):
        flows = self.db.list_flows()
        self.flow_name_to_id = {f["name"]: f["id"] for f in flows}
        names = list(self.flow_name_to_id)
        dpg.configure_item("flow_list", items=names)
        if select_name and select_name in names:
            dpg.set_value("flow_list", select_name)

    def on_flow_selected(self, sender=None, app_data=None):
        name = app_data if isinstance(app_data, str) else dpg.get_value("flow_list")
        fid = self.flow_name_to_id.get(name)
        if not fid or fid == self.current_flow_id:
            return
        self.save_current(silent=True)  # don't lose edits when switching
        self.open_flow(fid)

    def open_flow(self, flow_id):
        flow = self.db.get_flow(flow_id)
        if flow is None:
            return
        self.current_flow_id = flow_id
        self.load_graph(flow["graph"])
        dpg.set_value("current_flow_text", f"Flow: {flow['name']}")
        self.set_status(f"Loaded flow '{flow['name']}'.")

    def save_current(self, silent=False):
        if not self.current_flow_id:
            if not silent:
                self.set_status("No flow open. Create one first.", COL_FAIL)
            return False
        try:
            self.db.save_graph(self.current_flow_id, self.serialize())
            if not silent:
                self.set_status("Flow saved.", COL_PASS)
            return True
        except Exception as e:
            self.set_status(f"Save failed: {e}", COL_FAIL)
            return False

    def on_new_flow_ok(self):
        name = (dpg.get_value("dlg_new_name") or "").strip()
        dpg.configure_item("dlg_new", show=False)
        if not name:
            return
        if name in self.flow_name_to_id:
            self.set_status(f"A flow named '{name}' already exists.", COL_FAIL)
            return
        self.save_current(silent=True)
        fid = self.db.create_flow(name)
        self.refresh_flow_list(select_name=name)
        self.open_flow(fid)

    def on_rename_ok(self):
        name = (dpg.get_value("dlg_rename_name") or "").strip()
        dpg.configure_item("dlg_rename", show=False)
        if not name or not self.current_flow_id:
            return
        if name in self.flow_name_to_id:
            self.set_status(f"A flow named '{name}' already exists.", COL_FAIL)
            return
        self.db.rename_flow(self.current_flow_id, name)
        self.refresh_flow_list(select_name=name)
        dpg.set_value("current_flow_text", f"Flow: {name}")
        self.set_status("Flow renamed.", COL_PASS)

    def on_duplicate(self):
        if not self.current_flow_id:
            return
        self.save_current(silent=True)
        flow = self.db.get_flow(self.current_flow_id)
        base = f"{flow['name']} copy"
        name, i = base, 2
        while name in self.flow_name_to_id:
            name, i = f"{base} {i}", i + 1
        fid = self.db.duplicate_flow(self.current_flow_id, name)
        self.refresh_flow_list(select_name=name)
        self.open_flow(fid)

    def on_delete_ok(self):
        dpg.configure_item("dlg_delete", show=False)
        if not self.current_flow_id:
            return
        self.db.delete_flow(self.current_flow_id)
        self.current_flow_id = None
        self.clear_editor()
        dpg.set_value("current_flow_text", "Flow: (none)")
        self.refresh_flow_list()
        self.set_status("Flow deleted.", COL_PASS)

    def _show_dialog(self, tag):
        if tag == "dlg_new":
            dpg.set_value("dlg_new_name", "")
        elif tag == "dlg_rename":
            flow = self.db.get_flow(self.current_flow_id) if self.current_flow_id else None
            if not flow:
                return
            dpg.set_value("dlg_rename_name", flow["name"])
        elif tag == "dlg_delete":
            if not self.current_flow_id:
                return
        w, h = dpg.get_viewport_client_width(), dpg.get_viewport_client_height()
        dpg.configure_item(tag, show=True, pos=[w // 2 - 180, h // 2 - 60])

    # ================= run =================

    def on_run(self):
        if self._running:
            self.set_status("A run is already in progress.", COL_SKIP)
            return
        if not self.current_flow_id:
            self.set_status("Open a flow first.", COL_FAIL)
            return
        if not self.save_current(silent=True):
            return
        flow = self.db.get_flow(self.current_flow_id)
        self._running = True
        dpg.configure_item("btn_run", enabled=False)
        self.set_status(f"Running '{flow['name']}' ...", COL_RUN)
        threading.Thread(target=self._run_thread, args=(flow,),
                         daemon=True).start()

    def _run_thread(self, flow):
        try:
            exec_id, status, error = self.engine.execute(
                flow["id"], flow["name"], flow["graph"])
            color = STATUS_COLORS.get(status, (255, 255, 255))
            msg = f"Run {status.upper()}"
            if error:
                msg += f" - {error.splitlines()[0][:160]}"
            self.set_status(msg, color)
            self.refresh_executions()
            self.show_steps(exec_id)
        except Exception:
            self.set_status("Run crashed: " + traceback.format_exc(limit=1),
                            COL_FAIL)
        finally:
            self._running = False
            dpg.configure_item("btn_run", enabled=True)

    # ================= executions panel =================

    def refresh_executions(self):
        dpg.delete_item("tbl_exec", children_only=True, slot=1)
        for ex in self.db.list_executions():
            color = STATUS_COLORS.get(ex["status"], (255, 255, 255))
            with dpg.table_row(parent="tbl_exec"):
                dpg.add_selectable(
                    label=_ts(ex["started_at"]), span_columns=True,
                    callback=self._on_exec_row, user_data=ex["id"])
                dpg.add_text(ex["flow_name"] or "?")
                dpg.add_text(ex["status"], color=color)
                dpg.add_text(_dur(ex["started_at"], ex["finished_at"]))
                dpg.add_text((ex["error"] or "").splitlines()[0][:80]
                             if ex["error"] else "")

    def _on_exec_row(self, sender, app_data, user_data):
        self.show_steps(user_data)

    def show_steps(self, exec_id):
        ex = self.db.get_execution(exec_id)
        if ex:
            dpg.set_value(
                "steps_header",
                f"Steps for run at {_ts(ex['started_at'])} "
                f"({ex['flow_name']}, {ex['status']})")
        dpg.delete_item("tbl_steps", children_only=True, slot=1)
        for st in self.db.get_steps(exec_id):
            color = STATUS_COLORS.get(st["status"], (255, 255, 255))
            detail = (f"node:   {st['node_name']} ({st['node_type']})\n"
                      f"status: {st['status']}\n"
                      f"inputs: {st['inputs']}\n"
                      f"outputs:{st['outputs']}\n"
                      + (f"error:\n{st['error']}" if st["error"] else ""))
            with dpg.table_row(parent="tbl_steps"):
                dpg.add_selectable(
                    label=st["node_name"] or "?", span_columns=True,
                    callback=lambda s, a, u: dpg.set_value("step_detail", u),
                    user_data=detail)
                dpg.add_text(st["node_type"] or "?")
                dpg.add_text(st["status"], color=color)
                dpg.add_text(_dur(st["started_at"], st["finished_at"]))

    def on_clear_executions(self):
        self.db.clear_executions()
        self.refresh_executions()
        dpg.delete_item("tbl_steps", children_only=True, slot=1)
        dpg.set_value("step_detail", "")
        dpg.set_value("steps_header", "Steps")

    # ================= node palette =================

    def build_palette(self):
        dpg.delete_item("palette", children_only=True)
        for cat, items in self.registry.by_category().items():
            dpg.add_text(cat, parent="palette", color=COL_MUTED)
            for tname, cls in items:
                dpg.add_button(
                    label=f"+ {cls.label}", parent="palette", width=-1,
                    callback=lambda s, a, u: self.add_node(u), user_data=tname)
        if self.registry.errors:
            dpg.add_text("Load errors:", parent="palette", color=COL_FAIL)
            for fname, err in self.registry.errors:
                dpg.add_text(f"{fname}: {err}", parent="palette",
                             color=COL_FAIL, wrap=210)

    def on_reload_nodes(self):
        self.registry.load()
        self.build_palette()
        self.set_status(f"Reloaded {len(self.registry.types)} node types.",
                        COL_PASS)

    # ================= UI construction =================

    def build(self):
        with dpg.window(tag="main"):
            with dpg.menu_bar():
                with dpg.menu(label="Flow"):
                    dpg.add_menu_item(label="New Flow",
                                      callback=lambda: self._show_dialog("dlg_new"))
                    dpg.add_menu_item(label="Save  (current)",
                                      callback=lambda: self.save_current())
                    dpg.add_menu_item(label="Rename",
                                      callback=lambda: self._show_dialog("dlg_rename"))
                    dpg.add_menu_item(label="Duplicate",
                                      callback=lambda: self.on_duplicate())
                    dpg.add_menu_item(label="Delete",
                                      callback=lambda: self._show_dialog("dlg_delete"))
                with dpg.menu(label="Edit"):
                    dpg.add_menu_item(label="Delete selected nodes/links",
                                      callback=lambda: self.delete_selected())
                with dpg.menu(label="Nodes"):
                    dpg.add_menu_item(label="Reload nodes/ folder",
                                      callback=lambda: self.on_reload_nodes())

            with dpg.group(horizontal=True):
                # ---- left: flows + palette ----
                with dpg.child_window(width=240):
                    dpg.add_text("Flows")
                    dpg.add_listbox(items=[], tag="flow_list", width=-1,
                                    num_items=8,
                                    callback=self.on_flow_selected)
                    with dpg.group(horizontal=True):
                        dpg.add_button(label="New",
                                       callback=lambda: self._show_dialog("dlg_new"))
                        dpg.add_button(label="Ren",
                                       callback=lambda: self._show_dialog("dlg_rename"))
                        dpg.add_button(label="Dup",
                                       callback=lambda: self.on_duplicate())
                        dpg.add_button(label="Del",
                                       callback=lambda: self._show_dialog("dlg_delete"))
                    dpg.add_separator()
                    dpg.add_text("Add node")
                    with dpg.group(tag="palette"):
                        pass
                    dpg.add_separator()
                    dpg.add_button(label="Reload nodes/", width=-1,
                                   callback=lambda: self.on_reload_nodes())

                # ---- right: editor + executions ----
                with dpg.group():
                    with dpg.group(horizontal=True):
                        dpg.add_text("Flow: (none)", tag="current_flow_text")
                        dpg.add_button(label="Save",
                                       callback=lambda: self.save_current())
                        dpg.add_button(label="Run", tag="btn_run",
                                       callback=lambda: self.on_run())
                        dpg.add_button(label="Delete selected",
                                       callback=lambda: self.delete_selected())
                        dpg.add_button(label="-", callback=lambda: self.zoom_out())
                        dpg.add_text("100%", tag="zoom_text")
                        dpg.add_button(label="+", callback=lambda: self.zoom_in())
                        dpg.add_text("", tag="status_text")
                    with dpg.child_window(height=-320):
                        dpg.add_node_editor(
                            tag="editor", callback=self.on_link,
                            delink_callback=self.on_delink, minimap=True,
                            minimap_location=dpg.mvNodeMiniMap_Location_BottomRight)
                    with dpg.child_window(height=-1):
                        with dpg.group(horizontal=True):
                            dpg.add_text("Executions")
                            dpg.add_button(label="Refresh",
                                           callback=lambda: self.refresh_executions())
                            dpg.add_button(label="Clear history",
                                           callback=lambda: self.on_clear_executions())
                        with dpg.group(horizontal=True):
                            with dpg.child_window(width=520):
                                with dpg.table(tag="tbl_exec", header_row=True,
                                               scrollY=True, resizable=True,
                                               policy=dpg.mvTable_SizingStretchProp):
                                    dpg.add_table_column(label="Started")
                                    dpg.add_table_column(label="Flow")
                                    dpg.add_table_column(label="Status")
                                    dpg.add_table_column(label="Duration")
                                    dpg.add_table_column(label="Error")
                            with dpg.child_window(width=420):
                                dpg.add_text("Steps", tag="steps_header")
                                with dpg.table(tag="tbl_steps", header_row=True,
                                               scrollY=True, resizable=True,
                                               height=140,
                                               policy=dpg.mvTable_SizingStretchProp):
                                    dpg.add_table_column(label="Node")
                                    dpg.add_table_column(label="Type")
                                    dpg.add_table_column(label="Status")
                                    dpg.add_table_column(label="Duration")
                            with dpg.child_window():
                                dpg.add_text("Step detail")
                                dpg.add_input_text(tag="step_detail",
                                                   multiline=True, readonly=True,
                                                   width=-1, height=-1)

        # ---- modal dialogs ----
        with dpg.window(label="New Flow", tag="dlg_new", modal=True,
                        show=False, no_resize=True, width=360, height=110):
            dpg.add_input_text(label="name", tag="dlg_new_name",
                               on_enter=True,
                               callback=lambda: self.on_new_flow_ok())
            with dpg.group(horizontal=True):
                dpg.add_button(label="Create",
                               callback=lambda: self.on_new_flow_ok())
                dpg.add_button(label="Cancel",
                               callback=lambda: dpg.configure_item("dlg_new", show=False))

        with dpg.window(label="Rename Flow", tag="dlg_rename", modal=True,
                        show=False, no_resize=True, width=360, height=110):
            dpg.add_input_text(label="name", tag="dlg_rename_name",
                               on_enter=True,
                               callback=lambda: self.on_rename_ok())
            with dpg.group(horizontal=True):
                dpg.add_button(label="Rename",
                               callback=lambda: self.on_rename_ok())
                dpg.add_button(label="Cancel",
                               callback=lambda: dpg.configure_item("dlg_rename", show=False))

        with dpg.window(label="Delete Flow?", tag="dlg_delete", modal=True,
                        show=False, no_resize=True, width=360, height=110):
            dpg.add_text("Delete the current flow? This cannot be undone.")
            with dpg.group(horizontal=True):
                dpg.add_button(label="Delete",
                               callback=lambda: self.on_delete_ok())
                dpg.add_button(label="Cancel",
                               callback=lambda: dpg.configure_item("dlg_delete", show=False))

        self.build_palette()
        self.refresh_flow_list()
        self.refresh_executions()

        flows = self.db.list_flows()
        if flows:
            dpg.set_value("flow_list", flows[0]["name"])
            self.open_flow(flows[0]["id"])

    def _setup_font(self):
        """Bind a nicer, larger UI font; fall back to scaling the default."""
        candidates = []
        if _FONT_DIR.is_dir():
            candidates += [str(p) for p in sorted(_FONT_DIR.glob("*.ttf"))]
            candidates += [str(p) for p in sorted(_FONT_DIR.glob("*.otf"))]
        candidates += FONT_CANDIDATES
        for path in candidates:
            if not Path(path).is_file():
                continue
            try:
                with dpg.font_registry():
                    font = dpg.add_font(path, FONT_SIZE)
                dpg.bind_font(font)
                return
            except Exception:
                continue
        dpg.set_global_font_scale(1.15)  # no font found; just scale up

    def run(self):
        dpg.create_context()
        self._setup_font()
        dpg.create_viewport(title="NBT - Node Based Tester",
                            width=1440, height=900)
        self.build()
        dpg.set_primary_window("main", True)
        dpg.setup_dearpygui()
        dpg.show_viewport()
        try:
            dpg.start_dearpygui()
        finally:
            self.save_current(silent=True)
            dpg.destroy_context()
            self.db.close()

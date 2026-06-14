// Ports nbt/web/litegraph_embed.js to a reusable controller bound to a
// <canvas>. Registers one LiteGraph node class per NBT node type and
// serializes to / from the NBT graph JSON the engine understands.
import { LiteGraph, LGraph, LGraphCanvas } from "litegraph.js";
import type { Graph, GraphNode, NodeMeta } from "../types";

function coerce(meta: NodeMeta, name: string, value: unknown): unknown {
  const p = meta.params.find((q) => q.name === name);
  if (!p) return value;
  if (p.kind === "int") return Math.round(Number(value) || 0);
  if (p.kind === "float") return Number(value) || 0.0;
  if (p.kind === "bool") return !!value;
  return String(value === undefined || value === null ? "" : value);
}

export class NbtGraph {
  graph: any;
  canvas: any;
  private el: HTMLCanvasElement;
  private types: Record<string, NodeMeta> = {};
  private counter = 0;
  private orphans: GraphNode[] = [];
  private keyGuard?: (e: KeyboardEvent) => void;

  constructor(el: HTMLCanvasElement, metas: NodeMeta[]) {
    this.el = el;
    LiteGraph.registered_node_types = {};
    LiteGraph.searchbox_extras = {};
    // Keep value/search popups open until the user commits or presses Esc —
    // the default auto-closes them when the mouse leaves, which makes editing
    // widget values feel flaky.
    LiteGraph.dialog_close_on_mouse_leave = false;
    LiteGraph.search_hide_on_mouse_leave = false;
    metas.forEach((m) => {
      this.types[m.type] = m;
      LiteGraph.registerNodeType("nbt/" + m.type, this.makeClass(m));
    });

    this.graph = new LGraph();
    this.canvas = new LGraphCanvas(el, this.graph);
    // Disable the double-click (and shift-drag) "add node" search dialog.
    // Nodes are added via the right-click menu, the toolbar, and the palette.
    this.canvas.allow_searchbox = false;
    this.installAutoId();
    this.installKeyGuard();
    // NOTE: do NOT call graph.start(). LGraphCanvas already runs its own
    // requestAnimationFrame render loop (startRendering); graph.start() adds a
    // second per-frame runStep loop that re-executes nodes and double-drives
    // redraws, which makes nodes flicker on update.
  }

  // Stop Backspace from deleting the selected node / navigating the browser
  // back. We capture on the canvas' parent (runs before LiteGraph's own
  // capture-phase key handler) and only block when focus is on the canvas,
  // so Backspace still works inside node text-widget inputs. Delete still
  // removes nodes.
  private installKeyGuard() {
    const parent = this.el.parentElement;
    if (!parent) return;
    this.keyGuard = (e: KeyboardEvent) => {
      if (e.key !== "Backspace") return;
      const t = e.target as HTMLElement | null;
      const tag = t?.localName;
      if (tag === "input" || tag === "textarea" || t?.isContentEditable) return;
      e.preventDefault();
      e.stopPropagation();
    };
    parent.addEventListener("keydown", this.keyGuard, true);
  }

  private makeClass(meta: NodeMeta) {
    function N(this: any) {
      if (!meta.is_trigger) this.addInput("in", "flow");
      this.addOutput("out", "flow");
      this.w = {} as Record<string, any>;
      meta.params.forEach((p) => {
        if (p.kind === "bool") {
          this.w[p.name] = this.addWidget(
            "toggle", p.name, !!p.default, () => {});
        } else if (p.kind === "int") {
          this.w[p.name] = this.addWidget(
            "number", p.name, Number(p.default), () => {},
            { step: 10, precision: 0 });
        } else if (p.kind === "float") {
          this.w[p.name] = this.addWidget(
            "number", p.name, Number(p.default), () => {},
            { step: 1, precision: 2 });
        } else {
          this.w[p.name] = this.addWidget(
            "text", p.name, String(p.default), () => {});
        }
      });
      this.cw = this.addWidget(
        "text", meta.is_trigger ? "pre (filter)" : "pre",
        "", () => {});
      if (!meta.is_trigger) {
        this.aw = this.addWidget("text", "post", "", () => {});
      }
      this.ow = {} as Record<string, any>;
      meta.outputs.forEach((o) => {
        this.ow[o] = this.addWidget("text", "→ " + o, "", () => {});
      });
      this.properties = { nbt_id: null, nbt_name: null };
      this.serialize_widgets = true;
      this.size = this.computeSize();
      this.size[0] = Math.max(this.size[0], 240);
    }
    (N as any).title = meta.label + (meta.is_trigger ? " ⚡" : "");
    (N as any).prototype.nbtType = meta.type;
    return N as any;
  }

  private installAutoId() {
    const self = this;
    this.graph.onNodeAdded = function (node: any) {
      if (node.properties && !node.properties.nbt_id) {
        node.properties.nbt_id = "n" + ++self.counter;
        node.properties.nbt_name =
          (node.nbtType || "node") + "_" + node.properties.nbt_id;
        // The visible title IS the node name, so edits to it are saved.
        node.title = node.properties.nbt_name;
      }
    };
  }

  resize() {
    const parent = this.el.parentElement;
    if (!parent) return;
    const r = parent.getBoundingClientRect();
    this.el.width = r.width;
    this.el.height = r.height;
    this.canvas.resize();
    this.canvas.setDirty(true, true);
  }

  addNode(type: string) {
    const n = LiteGraph.createNode("nbt/" + type);
    if (!n) return;
    const c = this.canvas.ds ? this.canvas.ds.offset : [0, 0];
    n.pos = [80 - c[0] + Math.random() * 140, 80 - c[1] + Math.random() * 140];
    this.graph.add(n);
  }

  categories(): Record<string, NodeMeta[]> {
    const out: Record<string, NodeMeta[]> = {};
    Object.values(this.types).forEach((m) => {
      (out[m.category] ||= []).push(m);
    });
    return out;
  }

  exportGraph(): Graph {
    const nodes: GraphNode[] = [];
    const links: [string, string][] = [];
    this.graph._nodes.forEach((n: any) => {
      if (!n.nbtType || !this.types[n.nbtType]) return;
      const meta = this.types[n.nbtType];
      const params: Record<string, unknown> = {};
      for (const k in n.w) params[k] = coerce(meta, k, n.w[k].value);
      const aliases: Record<string, string> = {};
      for (const o in n.ow) {
        const v = String(n.ow[o].value || "").trim();
        if (v) aliases[o] = v;
      }
      const title = String(n.title || "").trim();
      const name = title || n.properties.nbt_name;
      // keep the internal name in sync with the (possibly edited) title
      n.properties.nbt_name = name;
      nodes.push({
        id: n.properties.nbt_id,
        type: n.nbtType,
        name,
        params,
        pre: n.cw ? String(n.cw.value || "") : "",
        post: n.aw ? String(n.aw.value || "") : "",
        out_aliases: aliases,
        pos: [Math.round(n.pos[0]), Math.round(n.pos[1])],
      });
    });
    for (const id in this.graph.links) {
      const l = this.graph.links[id];
      if (!l) continue;
      const a = this.graph.getNodeById(l.origin_id);
      const b = this.graph.getNodeById(l.target_id);
      if (a && b && a.properties.nbt_id && b.properties.nbt_id) {
        links.push([a.properties.nbt_id, b.properties.nbt_id]);
      }
    }
    this.orphans.forEach((nd) => nodes.push(nd));
    return { nodes, links };
  }

  importGraph(data: Graph) {
    this.graph.clear();
    this.graph.onNodeAdded = null;
    this.counter = 0;
    this.orphans = [];
    const byId: Record<string, any> = {};
    (data.nodes || []).forEach((nd) => {
      const node = LiteGraph.createNode("nbt/" + nd.type);
      if (!node) {
        this.orphans.push(nd);
        return;
      }
      node.pos = [(nd.pos && nd.pos[0]) || 60, (nd.pos && nd.pos[1]) || 60];
      this.graph.add(node);
      node.properties.nbt_id = nd.id;
      node.properties.nbt_name = nd.name || null;
      // show the saved name as the editable node title
      if (nd.name) node.title = nd.name;
      const m = parseInt(String(nd.id).replace(/^n/, ""), 10);
      if (!isNaN(m) && m > this.counter) this.counter = m;
      for (const k in nd.params || {}) {
        if (node.w[k] !== undefined) node.w[k].value = nd.params[k];
      }
      const legacy = nd as unknown as { condition?: string; assert?: string };
      if (node.cw) node.cw.value = nd.pre || legacy.condition || "";
      if (node.aw) node.aw.value = nd.post || legacy.assert || "";
      for (const o in nd.out_aliases || {}) {
        if (node.ow[o]) node.ow[o].value = nd.out_aliases[o];
      }
      byId[nd.id] = node;
    });
    (data.links || []).forEach((l) => {
      const a = byId[l[0]];
      const b = byId[l[1]];
      if (a && b) a.connect(0, b, 0);
    });
    this.installAutoId();
    this.canvas.setDirty(true, true);
  }

  setTheme(dark: boolean) {
    // LiteGraph clear color lives on the canvas instance.
    this.canvas.clear_background_color = dark ? "#141414" : "#fafafa";
    this.canvas.background_image = null;
    this.canvas.render_grid = true;
    this.canvas.setDirty(true, true);
  }

  destroy() {
    if (this.keyGuard && this.el.parentElement) {
      this.el.parentElement.removeEventListener("keydown", this.keyGuard, true);
    }
    try {
      this.canvas.stopRendering();
      this.graph.stop();
    } catch {
      /* ignore */
    }
  }
}

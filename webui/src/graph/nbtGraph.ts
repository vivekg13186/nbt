// Ports nbt/web/litegraph_embed.js to a reusable controller bound to a
// <canvas>. Registers one LiteGraph node class per NBT node type and
// serializes to / from the NBT graph JSON the engine understands.
import { LiteGraph, LGraph, LGraphCanvas } from "litegraph.js";
import type { Graph, GraphNode, NodeMeta } from "../types";

// ---- cross-flow clipboard -------------------------------------------------
// Copy/paste must survive switching flows (the editor reuses one NbtGraph
// instance and swaps graphs), so the clipboard lives at module scope. We also
// mirror it to localStorage as a best effort so copy works across windows.
interface ClipNode {
  note?: boolean;
  text?: string;
  type?: string;
  title?: string;
  params?: Record<string, unknown>;
  pre?: string;
  post?: string;
  out_aliases?: Record<string, string>;
  pos: [number, number];
  size?: [number, number];
}
interface Clip {
  nodes: ClipNode[];
  links: [number, number][]; // indices into nodes[]
}
const CLIP_KEY = "nbt.clipboard";
let clipboard: Clip | null = null;
function writeClipboard(c: Clip) {
  clipboard = c;
  try {
    localStorage.setItem(CLIP_KEY, JSON.stringify(c));
  } catch {
    /* storage unavailable: module var still works within this window */
  }
}
function readClipboard(): Clip | null {
  if (clipboard) return clipboard;
  try {
    const s = localStorage.getItem(CLIP_KEY);
    return s ? (JSON.parse(s) as Clip) : null;
  } catch {
    return null;
  }
}

// A LiteGraph input slot holds a single link, so to allow joins (a node with
// several parents) we give nodes a dynamic number of flow input pins: there is
// always exactly one free "in" pin, and a new one appears each time you wire a
// parent in. Trailing empty pins are trimmed when parents are removed.
function syncFlowInputs(node: any) {
  if (!node.inputs) return;
  // trim trailing empty pins, keeping a single free one
  while (
    node.inputs.length > 1 &&
    node.inputs[node.inputs.length - 1].link == null &&
    node.inputs[node.inputs.length - 2].link == null
  ) {
    node.removeInput(node.inputs.length - 1);
  }
  const hasFree = node.inputs.some((i: any) => i.link == null);
  if (!hasFree) node.addInput("in", "flow");
}

function freeInputSlot(node: any): number {
  for (let i = 0; i < node.inputs.length; i++) {
    if (node.inputs[i].link == null) return i;
  }
  node.addInput("in", "flow");
  return node.inputs.length - 1;
}

// A custom LiteGraph widget: a value box with an inline ✎ icon. Clicking it
// opens the code-editor dialog (controller.onEdit). Replaces the plain text
// widget + separate edit button. Value lives on widget.value (so export /
// import keep working unchanged).
function editWidget(
  controller: NbtGraph,
  label: string,
  initial: string,
  placeholder = "",
  variant: "input" | "output" = "input",
) {
  return {
    type: "nbt_edit",
    name: label,
    value: initial,
    draw(this: any, ctx: any, _node: any, width: number, y: number, H: number) {
      const m = 15;
      const iconW = 22;
      // box
      ctx.strokeStyle = LiteGraph.WIDGET_OUTLINE_COLOR;
      ctx.fillStyle = LiteGraph.WIDGET_BGCOLOR;
      ctx.beginPath();
      ctx.roundRect(m, y, width - m * 2, H, [H * 0.5]);
      ctx.fill();
      ctx.stroke();
      ctx.save();
      ctx.beginPath();
      ctx.rect(m, y, width - m * 2, H);
      ctx.clip();
      // label
      ctx.fillStyle = LiteGraph.WIDGET_SECONDARY_TEXT_COLOR;
      ctx.textAlign = "left";
      ctx.fillText(label, m * 2, y + H * 0.7);
      // value (truncated, single line)
      const raw = String(this.value ?? "");
      const shown = raw
        ? raw.replace(/\s+/g, " ").slice(0, 28)
        : placeholder;
      ctx.fillStyle = raw
        ? LiteGraph.WIDGET_TEXT_COLOR
        : LiteGraph.WIDGET_SECONDARY_TEXT_COLOR;
      ctx.textAlign = "right";
      ctx.fillText(shown, width - m - iconW - 4, y + H * 0.7);
      ctx.restore();
      // lucide "circle-dot" icon — blue for inputs, yellow for outputs
      const s = 14;
      const cx = width - m - iconW * 0.5;
      const cy = y + H * 0.5;
      const sc = s / 24;
      const color = variant === "output" ? "#faad14" : "#1668dc";
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 2 * sc;
      ctx.beginPath();
      ctx.arc(cx, cy, 10 * sc, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, 1.6 * sc, 0, Math.PI * 2);
      ctx.fill();
    },
    mouse(this: any, event: any, _pos: number[], _node: any) {
      if (controller.readOnly) return false; // view-only: no value editing
      if (!event.type || event.type.indexOf("down") < 0) return false;
      controller.onEdit?.({
        title: label,
        value: String(this.value ?? ""),
        apply: (v: string) => {
          this.value = v;
          controller.canvas.setDirty(true, true);
          controller.scheduleRecord();
        },
      });
      return true;
    },
  };
}

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
  private mmHandlers: Array<[string, (e: any) => void]> = [];
  private mmRect?: {
    x0: number; y0: number; w: number; h: number;
    minx: number; miny: number; s: number; ox: number; oy: number;
  };
  readOnly = false; // when true: view-only (snapshot), no edits / value dialog
  showMinimap = true;
  // undo/redo history (snapshots of exportGraph JSON)
  private history: string[] = [];
  private histIndex = -1;
  private restoring = false;
  private recordTimer: ReturnType<typeof setTimeout> | null = null;
  // set by the React layer to open a code-editor modal for a text field
  onEdit?: (req: {
    title: string;
    value: string;
    apply: (v: string) => void;
  }) => void;
  // fired when nodes are added/removed/loaded (so the UI can react)
  onGraphChange?: () => void;
  // fired when the undo/redo stack changes (so the toolbar can enable buttons)
  onHistoryChange?: () => void;
  // fired on Ctrl/Cmd+S (the React layer saves the active flow)
  onSave?: () => void;

  // does the graph currently contain a trigger node?
  hasTrigger(): boolean {
    return (this.graph._nodes || []).some(
      (n: any) => this.types[n.nbtType]?.is_trigger,
    );
  }

  constructor(
    el: HTMLCanvasElement,
    metas: NodeMeta[],
    opts: { readOnly?: boolean; reuseTypes?: boolean } = {},
  ) {
    this.el = el;
    this.readOnly = !!opts.readOnly;
    // Keep value/search popups open until the user commits or presses Esc —
    // the default auto-closes them when the mouse leaves, which makes editing
    // widget values feel flaky.
    LiteGraph.dialog_close_on_mouse_leave = false;
    LiteGraph.search_hide_on_mouse_leave = false;
    // `LiteGraph.registered_node_types` is a global singleton. A second
    // instance (e.g. the read-only version viewer) must NOT reset it — that
    // would clobber the main editor's classes and leave nodes unrendered.
    // Reuse the already-registered types instead.
    if (opts.reuseTypes) {
      metas.forEach((m) => (this.types[m.type] = m));
    } else {
      LiteGraph.registered_node_types = {};
      LiteGraph.searchbox_extras = {};
      metas.forEach((m) => {
        this.types[m.type] = m;
        LiteGraph.registerNodeType("nbt/" + m.type, this.makeClass(m));
      });
      // UI-only annotation node (not in `this.types`, so the engine never
      // sees it; persisted separately as graph `notes`).
      LiteGraph.registerNodeType("nbt/note", this.makeNoteClass());
    }

    this.graph = new LGraph();
    this.canvas = new LGraphCanvas(el, this.graph);
    // Disable the double-click (and shift-drag) "add node" search dialog.
    // Nodes are added via the right-click menu, the toolbar, and the palette.
    this.canvas.allow_searchbox = false;
    if (this.readOnly) {
      this.canvas.read_only = true; // block edits / connections
      this.canvas.allow_interaction = false; // also block widget clicks
    }
    this.installAutoId();
    this.installKeyGuard();
    this.installHiDPI();
    this.installMinimap();
    // NOTE: do NOT call graph.start(). LGraphCanvas already runs its own
    // requestAnimationFrame render loop (startRendering); graph.start() adds a
    // second per-frame runStep loop that re-executes nodes and double-drives
    // redraws, which makes nodes flicker on update.
    this.initHistory();
  }

  // Keyboard shortcuts + the Backspace guard. We capture on the canvas' parent
  // (runs before LiteGraph's own capture-phase key handler) and only act when
  // focus is on the canvas, so typing in node text widgets / modals is never
  // hijacked. Backspace is swallowed so it can't delete a node or navigate the
  // browser back; Delete still removes nodes (handled by LiteGraph).
  private installKeyGuard() {
    const parent = this.el.parentElement;
    if (!parent) return;
    this.keyGuard = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.localName;
      if (tag === "input" || tag === "textarea" || t?.isContentEditable) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      // always swallow a bare Backspace over the canvas
      if (e.key === "Backspace" && !mod) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (this.readOnly) return;
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (mod && k === "z") {
        stop();
        if (e.shiftKey) this.redo();
        else this.undo();
      } else if (mod && k === "y") {
        stop();
        this.redo();
      } else if (mod && k === "c") {
        if (this.copySelection()) stop();
      } else if (mod && k === "x") {
        if (this.cut()) stop();
      } else if (mod && k === "v") {
        if (this.paste()) stop();
      } else if (mod && k === "d") {
        stop();
        this.duplicate();
      } else if (mod && k === "a") {
        stop();
        this.selectAll();
      } else if (mod && k === "s") {
        stop();
        this.onSave?.();
      } else if (!mod && k === "f") {
        stop();
        this.zoomToFit();
      } else if (!mod && k === "l") {
        stop();
        this.autoLayout();
      }
    };
    parent.addEventListener("keydown", this.keyGuard, true);
  }

  private makeClass(meta: NodeMeta) {
    const controller = this;
    function N(this: any) {
      if (!meta.is_trigger) this.addInput("in", "flow");
      this.addOutput("out", "flow");
      this.w = {} as Record<string, any>;
      const rec = () => controller.scheduleRecord();
      meta.params.forEach((p) => {
        if (p.kind === "bool") {
          this.w[p.name] = this.addWidget(
            "toggle", p.name, !!p.default, rec);
        } else if (p.kind === "int") {
          this.w[p.name] = this.addWidget(
            "number", p.name, Number(p.default), rec,
            { step: 10, precision: 0 });
        } else if (p.kind === "float") {
          this.w[p.name] = this.addWidget(
            "number", p.name, Number(p.default), rec,
            { step: 1, precision: 2 });
        } else {
          // custom widget: value box + icon -> opens the code-editor dialog
          this.w[p.name] = this.addCustomWidget(
            editWidget(controller, p.name, String(p.default), "", "input"));
        }
      });
      this.cw = this.addWidget(
        "text", meta.is_trigger ? "pre (filter)" : "pre",
        "", rec);
      if (!meta.is_trigger) {
        this.aw = this.addWidget("text", "post", "", rec);
      }
      this.ow = {} as Record<string, any>;
      meta.outputs.forEach((o) => {
        this.ow[o] = this.addCustomWidget(
          editWidget(controller, "→ " + o, "", "alias", "output"));
      });
      this.properties = { nbt_id: null, nbt_name: null };
      this.serialize_widgets = true;
      this.size = this.computeSize();
      this.size[0] = Math.max(this.size[0], 240);
    }
    (N as any).title = meta.label + (meta.is_trigger ? " ⚡" : "");
    (N as any).prototype.nbtType = meta.type;
    // Non-trigger nodes accept multiple parents (joins) via dynamic input pins.
    if (!meta.is_trigger) {
      (N as any).prototype.onConnectionsChange = function (
        type: number,
        _slot: number,
        _connected: boolean,
        _link: any,
        _ioSlot: any,
      ) {
        if (type === LiteGraph.INPUT) syncFlowInputs(this);
      };
    }
    return N as any;
  }

  // A free-text annotation node ("Note"). No pins, not an engine node.
  private makeNoteClass() {
    const controller = this;
    function Note(this: any) {
      this.properties = { nbt_id: null, text: "" };
      this.size = [240, 130];
      this.resizable = true;
      this.color = "#6b5e2a";
      this.bgcolor = "#3a3320";
    }
    (Note as any).title = "Note";
    (Note as any).prototype.nbtType = "note";
    (Note as any).prototype.onDrawForeground = function (ctx: any) {
      if (this.flags && this.flags.collapsed) return;
      const pad = 8;
      const lineH = 15;
      const maxW = this.size[0] - pad * 2;
      let y = pad + 12;
      const text = String((this.properties && this.properties.text) || "");
      ctx.save();
      ctx.textAlign = "left";
      ctx.font = '12px -apple-system, system-ui, "Segoe UI", sans-serif';
      if (!text) {
        ctx.fillStyle = "#c9c39a";
        ctx.fillText("double-click to edit…", pad, y);
        ctx.restore();
        return;
      }
      ctx.fillStyle = "#f3eecb";
      for (const raw of text.split("\n")) {
        let cur = "";
        for (const word of raw.split(" ")) {
          const test = cur ? cur + " " + word : word;
          if (ctx.measureText(test).width > maxW && cur) {
            ctx.fillText(cur, pad, y);
            y += lineH;
            cur = word;
          } else {
            cur = test;
          }
          if (y > this.size[1] - 2) break;
        }
        ctx.fillText(cur, pad, y);
        y += lineH;
        if (y > this.size[1] - 2) break;
      }
      ctx.restore();
    };
    (Note as any).prototype.onDblClick = function (
      _e: any,
      _pos: any,
      canvas: any,
    ) {
      if (canvas && canvas.read_only) return; // view-only
      const node = this;
      controller.onEdit?.({
        title: "Note",
        value: String((node.properties && node.properties.text) || ""),
        apply: (v: string) => {
          node.properties.text = v;
          node.setDirtyCanvas?.(true, true);
          controller.scheduleRecord();
        },
      });
    };
    return Note as any;
  }

  addNote() {
    const n = LiteGraph.createNode("nbt/note");
    if (!n) return;
    const c = this.canvas.ds ? this.canvas.ds.offset : [0, 0];
    n.pos = [80 - c[0] + Math.random() * 140, 80 - c[1] + Math.random() * 140];
    this.graph.add(n);
  }

  // next unused node id (scans the graph so copy-paste can't collide)
  private nextId(): string {
    let max = this.counter;
    (this.graph._nodes || []).forEach((n: any) => {
      const id = n.properties && n.properties.nbt_id;
      const m = id ? parseInt(String(id).replace(/^n/, ""), 10) : NaN;
      if (!isNaN(m) && m > max) max = m;
    });
    this.counter = max + 1;
    return "n" + this.counter;
  }

  private installAutoId() {
    const self = this;
    this.graph.onNodeAdded = function (node: any) {
      if (!node.properties) return;
      // assign an id when missing, or when it collides with another node
      // (copy-paste clones nbt_id) so ids stay unique.
      const dup = (self.graph._nodes || []).some(
        (o: any) =>
          o !== node && o.properties &&
          o.properties.nbt_id === node.properties.nbt_id);
      if (!node.properties.nbt_id || dup) {
        const id = self.nextId();
        node.properties.nbt_id = id;
        const auto = (node.nbtType || "node") + "_" + id;
        // refresh the auto-generated name/title (keep a user-set title)
        const autoRe = new RegExp("^" + (node.nbtType || "node") + "_n\\d+$");
        if (!node.properties.nbt_name ||
            autoRe.test(String(node.title || ""))) {
          node.properties.nbt_name = auto;
          node.title = auto;
        }
      }
      self.onGraphChange?.();
      self.scheduleRecord();
    };
    this.graph.onNodeRemoved = function () {
      self.onGraphChange?.();
      self.scheduleRecord();
    };
    // wiring / unwiring links and dragging nodes are undoable too
    this.graph.onConnectionChange = function () {
      self.scheduleRecord();
    };
    this.canvas.onNodeMoved = function () {
      self.scheduleRecord();
    };
  }

  // Make the canvas crisp on HiDPI / Retina screens. LiteGraph has no DPR
  // support: it sizes its backing store in CSS pixels, so on a 2x display
  // everything is upscaled and blurry. We size the backing store in *device*
  // pixels and scale LiteGraph's draw transform by the DPR. Mouse mapping is
  // computed from CSS pixels / ds.scale, so it stays consistent.
  private installHiDPI() {
    const ds = this.canvas.ds;
    ds.toCanvasContext = function (ctx: any) {
      const d = window.devicePixelRatio || 1;
      ctx.scale(d * this.scale, d * this.scale);
      ctx.translate(this.offset[0], this.offset[1]);
    };
  }

  // ---------------- undo / redo ----------------
  private snapshot(): string {
    return JSON.stringify(this.exportGraph());
  }

  // (re)start the history with the current graph as the only entry
  initHistory() {
    this.history = [this.snapshot()];
    this.histIndex = 0;
    this.onHistoryChange?.();
  }

  // debounced record — coalesces a drag / typing burst into one entry
  scheduleRecord() {
    if (this.restoring || this.readOnly) return;
    if (this.recordTimer) clearTimeout(this.recordTimer);
    this.recordTimer = setTimeout(() => {
      this.recordTimer = null;
      this.recordHistory();
    }, 250);
  }

  recordHistory() {
    if (this.restoring || this.readOnly) return;
    const snap = this.snapshot();
    if (snap === this.history[this.histIndex]) return; // nothing changed
    // drop any redo branch, then append
    this.history = this.history.slice(0, this.histIndex + 1);
    this.history.push(snap);
    if (this.history.length > 120) this.history.shift();
    this.histIndex = this.history.length - 1;
    this.onHistoryChange?.();
  }

  canUndo(): boolean {
    return this.histIndex > 0;
  }
  canRedo(): boolean {
    return this.histIndex < this.history.length - 1;
  }

  undo() {
    if (!this.canUndo()) return;
    this.histIndex--;
    this.applyHistory();
  }
  redo() {
    if (!this.canRedo()) return;
    this.histIndex++;
    this.applyHistory();
  }

  private applyHistory() {
    this.restoring = true;
    try {
      this.importGraph(JSON.parse(this.history[this.histIndex]));
    } finally {
      this.restoring = false;
    }
    this.onHistoryChange?.();
  }

  // ---------------- selection / clipboard ----------------
  private selectedNodes(): any[] {
    const sel = this.canvas.selected_nodes;
    return sel ? Object.values(sel) : [];
  }

  selectAll() {
    const all = this.graph._nodes || [];
    if (typeof this.canvas.selectNodes === "function") {
      this.canvas.selectNodes(all);
    } else {
      all.forEach((n: any) => this.canvas.selectNode(n, true));
    }
    this.canvas.setDirty(true, true);
  }

  deleteSelection() {
    const sel = this.selectedNodes();
    if (!sel.length) return;
    sel.forEach((n: any) => this.graph.remove(n));
    this.canvas.setDirty(true, true);
    this.recordHistory();
  }

  private clipSerialize(n: any): ClipNode | null {
    const pos: [number, number] = [n.pos[0], n.pos[1]];
    const size: [number, number] | undefined = n.size
      ? [n.size[0], n.size[1]]
      : undefined;
    if (n.nbtType === "note") {
      return { note: true, text: String(n.properties?.text || ""), pos, size };
    }
    if (!n.nbtType || !this.types[n.nbtType]) return null;
    const params: Record<string, unknown> = {};
    for (const k in n.w) params[k] = n.w[k].value;
    const aliases: Record<string, string> = {};
    for (const o in n.ow) {
      const v = String(n.ow[o].value || "").trim();
      if (v) aliases[o] = v;
    }
    return {
      type: n.nbtType,
      title: String(n.title || ""),
      params,
      pre: n.cw ? String(n.cw.value || "") : "",
      post: n.aw ? String(n.aw.value || "") : "",
      out_aliases: aliases,
      pos,
      size,
    };
  }

  private serializeSelection(): Clip | null {
    const sel = this.selectedNodes().filter(
      (n: any) => n.nbtType && (n.nbtType === "note" || this.types[n.nbtType]),
    );
    if (!sel.length) return null;
    const idx = new Map<any, number>();
    sel.forEach((n, i) => idx.set(n, i));
    const nodes = sel.map((n: any) => this.clipSerialize(n)!) as ClipNode[];
    const links: [number, number][] = [];
    for (const id in this.graph.links) {
      const l = this.graph.links[id];
      if (!l) continue;
      const a = this.graph.getNodeById(l.origin_id);
      const b = this.graph.getNodeById(l.target_id);
      if (a && b && idx.has(a) && idx.has(b)) {
        links.push([idx.get(a)!, idx.get(b)!]);
      }
    }
    return { nodes, links };
  }

  copySelection(): boolean {
    const c = this.serializeSelection();
    if (!c) return false;
    writeClipboard(c);
    return true;
  }

  cut(): boolean {
    if (!this.copySelection()) return false;
    this.deleteSelection();
    return true;
  }

  paste(): boolean {
    const c = readClipboard();
    if (!c || !c.nodes.length) return false;
    return this.placeClip(c, this.viewCenterTopLeft());
  }

  duplicate(): boolean {
    const c = this.serializeSelection();
    if (!c) return false;
    const minx = Math.min(...c.nodes.map((n) => n.pos[0]));
    const miny = Math.min(...c.nodes.map((n) => n.pos[1]));
    return this.placeClip(c, [minx + 30, miny + 30]);
  }

  // world coord where the top-left of a pasted block should land (near the
  // centre of the current viewport, so it's always visible)
  private viewCenterTopLeft(): [number, number] {
    const ds = this.canvas.ds;
    const scale = ds.scale || 1;
    const cssW = this.el.clientWidth || 800;
    const cssH = this.el.clientHeight || 600;
    return [cssW / (2 * scale) - ds.offset[0] - 80,
      cssH / (2 * scale) - ds.offset[1] - 50];
  }

  // recreate clip nodes (with fresh ids) at `target`, reconnect internal
  // links, select them, and record one history entry.
  private placeClip(clip: Clip, target: [number, number]): boolean {
    if (this.readOnly || !clip.nodes.length) return false;
    const minx = Math.min(...clip.nodes.map((n) => n.pos[0]));
    const miny = Math.min(...clip.nodes.map((n) => n.pos[1]));
    const created: any[] = [];
    clip.nodes.forEach((cn) => {
      const node = LiteGraph.createNode(
        "nbt/" + (cn.note ? "note" : cn.type));
      if (!node) {
        created.push(null);
        return;
      }
      node.pos = [
        target[0] + (cn.pos[0] - minx),
        target[1] + (cn.pos[1] - miny),
      ];
      if (cn.size) node.size = [cn.size[0], cn.size[1]];
      this.graph.add(node); // onNodeAdded assigns a unique nbt_id
      if (cn.note) {
        node.properties.text = cn.text || "";
      } else {
        if (cn.title) {
          node.title = cn.title;
          node.properties.nbt_name = cn.title;
        }
        for (const k in cn.params || {}) {
          if (node.w[k] !== undefined) node.w[k].value = cn.params![k];
        }
        if (node.cw) node.cw.value = cn.pre || "";
        if (node.aw) node.aw.value = cn.post || "";
        for (const o in cn.out_aliases || {}) {
          if (node.ow[o]) node.ow[o].value = cn.out_aliases![o];
        }
      }
      created.push(node);
    });
    clip.links.forEach(([a, b]) => {
      const na = created[a];
      const nb = created[b];
      if (na && nb) na.connect(0, nb, freeInputSlot(nb));
    });
    if (typeof this.canvas.deselectAllNodes === "function") {
      this.canvas.deselectAllNodes();
    }
    created.forEach((n) => n && this.canvas.selectNode(n, true));
    this.canvas.setDirty(true, true);
    this.recordHistory();
    return created.some(Boolean);
  }

  // ---------------- auto-layout / fit ----------------
  // Longest-path layered layout: each node sits in a column one past its
  // deepest parent, stacked vertically within the column.
  autoLayout() {
    if (this.readOnly) return;
    const nodes = (this.graph._nodes || []).filter(
      (n: any) => n.nbtType && n.nbtType !== "note" && this.types[n.nbtType]);
    if (!nodes.length) return;
    const parents = new Map<any, any[]>();
    nodes.forEach((n: any) => parents.set(n, []));
    for (const id in this.graph.links) {
      const l = this.graph.links[id];
      if (!l) continue;
      const a = this.graph.getNodeById(l.origin_id);
      const b = this.graph.getNodeById(l.target_id);
      if (a && b && parents.has(b) && parents.has(a)) parents.get(b)!.push(a);
    }
    const layer = new Map<any, number>();
    const visiting = new Set<any>();
    const calc = (n: any): number => {
      if (layer.has(n)) return layer.get(n)!;
      if (visiting.has(n)) return 0; // cycle guard
      visiting.add(n);
      const ps = parents.get(n)!;
      const v = ps.length ? Math.max(...ps.map(calc)) + 1 : 0;
      visiting.delete(n);
      layer.set(n, v);
      return v;
    };
    nodes.forEach(calc);
    const byLayer = new Map<number, any[]>();
    nodes.forEach((n: any) => {
      const L = layer.get(n)!;
      if (!byLayer.has(L)) byLayer.set(L, []);
      byLayer.get(L)!.push(n);
    });
    const colGap = 110;
    const rowGap = 46;
    let x = 80;
    const maxLayer = Math.max(...layer.values());
    for (let L = 0; L <= maxLayer; L++) {
      const col = byLayer.get(L) || [];
      col.sort((a, b) => a.pos[1] - b.pos[1]); // keep rough vertical order
      const colW = Math.max(240, ...col.map((n) => (n.size ? n.size[0] : 240)));
      let y = 80;
      col.forEach((n: any) => {
        n.pos = [x, y];
        y += (n.size ? n.size[1] : 120) + rowGap;
      });
      x += colW + colGap;
    }
    this.canvas.setDirty(true, true);
    this.recordHistory();
    this.zoomToFit();
  }

  // Pan/zoom so the whole graph fits the viewport.
  zoomToFit(pad = 60) {
    const nodes = this.graph._nodes || [];
    if (!nodes.length) return;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    nodes.forEach((n: any) => {
      const w = n.size ? n.size[0] : 200;
      const h = n.size ? n.size[1] : 100;
      minx = Math.min(minx, n.pos[0]);
      miny = Math.min(miny, n.pos[1] - 24); // include the title bar
      maxx = Math.max(maxx, n.pos[0] + w);
      maxy = Math.max(maxy, n.pos[1] + h);
    });
    const bw = maxx - minx;
    const bh = maxy - miny;
    const cssW = this.el.clientWidth;
    const cssH = this.el.clientHeight;
    if (bw <= 0 || bh <= 0 || cssW <= 0 || cssH <= 0) return;
    let scale = Math.min((cssW - pad * 2) / bw, (cssH - pad * 2) / bh);
    scale = Math.max(0.1, Math.min(1.5, scale));
    const ds = this.canvas.ds;
    ds.scale = scale;
    ds.offset[0] = (cssW / scale - bw) / 2 - minx;
    ds.offset[1] = (cssH / scale - bh) / 2 - miny;
    this.canvas.setDirty(true, true);
  }

  setMinimap(on: boolean) {
    this.showMinimap = on;
    this.canvas.setDirty(true, true);
  }

  // ---------------- minimap ----------------
  private installMinimap() {
    const self = this;
    // draw the minimap on top of the rendered graph
    const prev = this.canvas.onDrawForeground;
    this.canvas.onDrawForeground = function (ctx: any, area: any) {
      if (prev) prev.call(this, ctx, area);
      self.drawMinimap(ctx);
    };
    if (this.readOnly) return; // view-only: no click-to-pan
    // click / drag inside the minimap pans the view. Capture on the parent so
    // we run before LiteGraph's own canvas drag handling.
    const parent = this.el.parentElement;
    if (!parent) return;
    let dragging = false;
    const toWorld = (e: MouseEvent): [number, number] | null => {
      const mm = self.mmRect;
      if (!mm || !self.showMinimap) return null;
      const rect = self.el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      if (px < mm.x0 || px > mm.x0 + mm.w || py < mm.y0 || py > mm.y0 + mm.h) {
        return null;
      }
      return [mm.minx + (px - mm.ox) / mm.s, mm.miny + (py - mm.oy) / mm.s];
    };
    const onDown = (e: MouseEvent) => {
      const w = toWorld(e);
      if (!w) return;
      dragging = true;
      self.centerOn(w[0], w[1]);
      e.preventDefault();
      e.stopPropagation();
    };
    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const w = toWorld(e);
      if (w) self.centerOn(w[0], w[1]);
      e.preventDefault();
      e.stopPropagation();
    };
    const onUp = () => {
      dragging = false;
    };
    parent.addEventListener("mousedown", onDown, true);
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    this.mmHandlers = [
      ["mousedown", onDown],
      ["mousemove", onMove],
      ["mouseup", onUp],
    ];
  }

  private centerOn(wx: number, wy: number) {
    const ds = this.canvas.ds;
    const scale = ds.scale || 1;
    const cssW = this.el.clientWidth;
    const cssH = this.el.clientHeight;
    ds.offset[0] = cssW / (2 * scale) - wx;
    ds.offset[1] = cssH / (2 * scale) - wy;
    this.canvas.setDirty(true, true);
  }

  private drawMinimap(ctx: any) {
    if (!this.showMinimap) return;
    const nodes = this.graph._nodes || [];
    if (!nodes.length) {
      this.mmRect = undefined;
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const cssW = this.el.clientWidth;
    const cssH = this.el.clientHeight;
    const w = 184;
    const h = 124;
    const margin = 14;
    const x0 = cssW - w - margin;
    const y0 = cssH - h - margin;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS-pixel screen space
    // panel
    ctx.fillStyle = "rgba(18,18,18,0.82)";
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x0, y0, w, h, 6);
    ctx.fill();
    ctx.stroke();
    // graph bounds
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    nodes.forEach((n: any) => {
      const nw = n.size ? n.size[0] : 200;
      const nh = n.size ? n.size[1] : 100;
      minx = Math.min(minx, n.pos[0]);
      miny = Math.min(miny, n.pos[1]);
      maxx = Math.max(maxx, n.pos[0] + nw);
      maxy = Math.max(maxy, n.pos[1] + nh);
    });
    const bw = Math.max(1, maxx - minx);
    const bh = Math.max(1, maxy - miny);
    const pad = 8;
    const s = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh);
    const ox = x0 + pad + ((w - pad * 2) - bw * s) / 2;
    const oy = y0 + pad + ((h - pad * 2) - bh * s) / 2;
    const mapX = (wx: number) => ox + (wx - minx) * s;
    const mapY = (wy: number) => oy + (wy - miny) * s;
    // nodes
    nodes.forEach((n: any) => {
      const nw = n.size ? n.size[0] : 200;
      const nh = n.size ? n.size[1] : 100;
      ctx.fillStyle =
        n.nbtType === "note" ? "rgba(214,173,20,0.8)" : "rgba(91,143,217,0.9)";
      ctx.fillRect(mapX(n.pos[0]), mapY(n.pos[1]),
        Math.max(2, nw * s), Math.max(2, nh * s));
    });
    // viewport rectangle (visible world region)
    const ds = this.canvas.ds;
    const scale = ds.scale || 1;
    const vx = -ds.offset[0];
    const vy = -ds.offset[1];
    const vw = cssW / scale;
    const vh = cssH / scale;
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(mapX(vx), mapY(vy), vw * s, vh * s);
    ctx.restore();
    this.mmRect = { x0, y0, w, h, minx, miny, s, ox, oy };
  }

  resize() {
    const parent = this.el.parentElement;
    if (!parent) return;
    // clientWidth/Height are layout sizes, unaffected by CSS transforms (a
    // modal's open animation scales the box, which would corrupt
    // getBoundingClientRect and leave the canvas mis-sized).
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(parent.clientWidth));
    const h = Math.max(1, Math.round(parent.clientHeight));
    // CSS (layout) size in CSS pixels…
    this.el.style.width = w + "px";
    this.el.style.height = h + "px";
    // …backing store in device pixels for crisp rendering.
    this.canvas.resize(Math.round(w * dpr), Math.round(h * dpr));
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
        size: n.size
          ? [Math.round(n.size[0]), Math.round(n.size[1])]
          : undefined,
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
    // persist group boxes (title / bounds / color) — UI metadata
    const groups = (this.graph._groups || []).map((g: any) =>
      typeof g.serialize === "function"
        ? g.serialize()
        : { title: g.title, bounding: g.bounding, color: g.color });
    // persist free-text Note annotations (UI-only; engine ignores them)
    const notes = (this.graph._nodes || [])
      .filter((n: any) => n.nbtType === "note")
      .map((n: any) => ({
        pos: [Math.round(n.pos[0]), Math.round(n.pos[1])],
        size: [Math.round(n.size[0]), Math.round(n.size[1])],
        text: String((n.properties && n.properties.text) || ""),
      }));
    return { nodes, links, groups, notes };
  }

  importGraph(data: Graph) {
    this.graph.clear();
    this.graph.onNodeAdded = null;
    this.counter = 0;
    this.orphans = [];
    const byId: Record<string, any> = {};
    const used = new Set<string>();
    (data.nodes || []).forEach((nd) => {
      const node = LiteGraph.createNode("nbt/" + nd.type);
      if (!node) {
        this.orphans.push(nd);
        return;
      }
      node.pos = [(nd.pos && nd.pos[0]) || 60, (nd.pos && nd.pos[1]) || 60];
      this.graph.add(node);
      // restore a user-adjusted size, if saved
      if (nd.size && nd.size.length === 2) {
        node.size = [nd.size[0], nd.size[1]];
      }
      // repair missing/duplicate ids from older graphs (copy-paste collisions)
      let nid = nd.id;
      if (!nid || used.has(nid)) nid = this.nextId();
      used.add(nid);
      node.properties.nbt_id = nid;
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
      // links reference the saved id; map to the first node that used it
      if (nd.id && !(nd.id in byId)) byId[nd.id] = node;
    });
    (data.links || []).forEach((l) => {
      const a = byId[l[0]];
      const b = byId[l[1]];
      // connect each parent into a fresh input pin so joins reload intact
      if (a && b) a.connect(0, b, freeInputSlot(b));
    });
    // restore group boxes
    ((data as Graph).groups || []).forEach((gd) => {
      try {
        const grp = new LiteGraph.LGraphGroup();
        if (typeof grp.configure === "function") grp.configure(gd);
        else Object.assign(grp, gd);
        this.graph.add(grp);
      } catch {
        /* ignore malformed group */
      }
    });
    // restore Note annotations
    ((data as Graph).notes || []).forEach((nd) => {
      const n = LiteGraph.createNode("nbt/note");
      if (!n) return;
      n.pos = [(nd.pos && nd.pos[0]) || 60, (nd.pos && nd.pos[1]) || 60];
      if (nd.size && nd.size.length === 2) n.size = [nd.size[0], nd.size[1]];
      n.properties.text = String(nd.text || "");
      this.graph.add(n);
    });
    this.installAutoId();
    this.canvas.setDirty(true, true);
    this.onGraphChange?.();
    // a fresh load starts a new history; undo/redo restores must not (they
    // manage histIndex themselves and set `restoring`).
    if (!this.restoring) this.initHistory();
  }

  setTheme(dark: boolean) {
    // LiteGraph clear color lives on the canvas instance.
    this.canvas.clear_background_color = dark ? "#141414" : "#fafafa";
    this.canvas.background_image = null;
    this.canvas.render_grid = true;
    this.canvas.setDirty(true, true);
  }

  destroy() {
    if (this.recordTimer) clearTimeout(this.recordTimer);
    if (this.keyGuard && this.el.parentElement) {
      this.el.parentElement.removeEventListener("keydown", this.keyGuard, true);
    }
    // remove minimap pan listeners (mousedown on parent, move/up on window)
    const parent = this.el.parentElement;
    this.mmHandlers.forEach(([type, fn]) => {
      if (type === "mousedown" && parent) {
        parent.removeEventListener(type, fn, true);
      } else {
        window.removeEventListener(type, fn, true);
      }
    });
    this.mmHandlers = [];
    try {
      this.canvas.stopRendering();
      this.graph.stop();
    } catch {
      /* ignore */
    }
  }
}

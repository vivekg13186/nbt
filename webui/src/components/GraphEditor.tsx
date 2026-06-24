import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { App as AntApp, Empty, Spin } from "antd";
import {
  addEdge,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useStore } from "../store";
import { api } from "../api";
import { activeGraphRef } from "../graph/active";
import {
  defaultsFor,
  flowToGraph,
  graphToFlow,
  type NbtData,
} from "../flow/serialize";
import { readClip, writeClip, type Clip } from "../flow/clipboard";
import NbtNode from "./NbtNode";
import PropertyPanel from "./PropertyPanel";

const ValueEditorModal = lazy(() => import("./ValueEditorModal"));

interface EditReq {
  title: string;
  value: string;
  apply: (v: string) => void;
}

const nodeTypes = { nbt: NbtNode };

// stable identity of a graph (ignores selection) — used to de-dup history
function graphKey(ns: Node[], es: Edge[]): string {
  return JSON.stringify({
    n: ns.map((n) => [
      n.id,
      Math.round(n.position.x),
      Math.round(n.position.y),
      n.data,
    ]),
    e: es.map((e) => [e.source, e.target]),
  });
}

function Editor() {
  const { message } = AntApp.useApp();
  const metas = useStore((s) => s.nodes);
  const activeFlowId = useStore((s) => s.activeFlowId);
  const setFlowHasTrigger = useStore((s) => s.setFlowHasTrigger);
  const setHistoryFlags = useStore((s) => s.setHistory);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // the node whose property panel is open (double-click to open) — separate
  // from React Flow's own selection (single click), which drives copy/delete.
  const [panelId, setPanelId] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditReq | null>(null);

  const wrapRef = useRef<HTMLDivElement>(null);
  const loadedFlow = useRef<string | null>(null);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;
  const rf = useReactFlow();

  const metaByType = useMemo(() => {
    const m: Record<string, (typeof metas)[number]> = {};
    metas.forEach((x) => (m[x.type] = x));
    return m;
  }, [metas]);

  // ----- history (undo / redo) -----
  const history = useRef<{ nodes: Node[]; edges: Edge[] }[]>([]);
  const histIndex = useRef(0);
  const restoring = useRef(false);
  const recTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setCanFlags = useCallback(() => {
    setHistoryFlags(
      histIndex.current > 0,
      histIndex.current < history.current.length - 1,
    );
  }, [setHistoryFlags]);

  const initHistory = useCallback(
    (ns: Node[], es: Edge[]) => {
      history.current = [{ nodes: ns, edges: es }];
      histIndex.current = 0;
      setCanFlags();
    },
    [setCanFlags],
  );

  const recordNow = useCallback(() => {
    if (restoring.current) return;
    const ns = nodesRef.current;
    const es = edgesRef.current;
    const cur = graphKey(ns, es);
    const last = history.current[histIndex.current];
    if (last && graphKey(last.nodes, last.edges) === cur) return;
    history.current = history.current.slice(0, histIndex.current + 1);
    history.current.push({ nodes: ns, edges: es });
    if (history.current.length > 100) history.current.shift();
    histIndex.current = history.current.length - 1;
    setCanFlags();
  }, [setCanFlags]);

  const scheduleRecord = useCallback(() => {
    if (restoring.current) return;
    if (recTimer.current) clearTimeout(recTimer.current);
    recTimer.current = setTimeout(recordNow, 250);
  }, [recordNow]);

  // record on any node/edge change (drag, add, delete, edit) — debounced
  useEffect(() => {
    scheduleRecord();
  }, [nodes, edges, scheduleRecord]);

  const applyHistory = useCallback(() => {
    restoring.current = true;
    const s = history.current[histIndex.current];
    setNodes(s.nodes);
    setEdges(s.edges);
    setPanelId(null);
    setCanFlags();
    setTimeout(() => {
      restoring.current = false;
    }, 40);
  }, [setNodes, setEdges, setCanFlags]);

  const undo = useCallback(() => {
    if (histIndex.current <= 0) return;
    histIndex.current--;
    applyHistory();
  }, [applyHistory]);

  const redo = useCallback(() => {
    if (histIndex.current >= history.current.length - 1) return;
    histIndex.current++;
    applyHistory();
  }, [applyHistory]);

  // ----- add / delete / edit -----
  const nextIds = useCallback((count: number) => {
    let max = 0;
    nodesRef.current.forEach((n) => {
      const m = parseInt(String(n.id).replace(/^n/, ""), 10);
      if (!isNaN(m) && m > max) max = m;
    });
    return Array.from({ length: count }, () => "n" + ++max);
  }, []);

  const viewportCenter = useCallback(() => {
    const rect = wrapRef.current?.getBoundingClientRect();
    return rect
      ? rf.screenToFlowPosition({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        })
      : { x: 120, y: 120 };
  }, [rf]);

  const addNodeOfType = useCallback(
    (type: string) => {
      const meta = metaByType[type];
      if (!meta) return;
      const [id] = nextIds(1);
      const pos = viewportCenter();
      const data: NbtData = {
        nbtType: type,
        name: `${type}_${id}`,
        label: meta.label,
        params: defaultsFor(meta),
        pre: "",
        post: "",
        aliases: {},
        isTrigger: !!meta.is_trigger,
        isSplit: !!meta.is_split,
      };
      setNodes((ns) => [
        ...ns.map((n) => ({ ...n, selected: false })),
        {
          id,
          type: "nbt",
          position: { x: pos.x - 70, y: pos.y - 15 },
          data: data as unknown as Record<string, unknown>,
          selected: true,
        },
      ]);
    },
    [metaByType, nextIds, viewportCenter, setNodes],
  );

  const deleteNode = useCallback(
    (id: string) => {
      setNodes((ns) => ns.filter((n) => n.id !== id));
      setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
      setPanelId((s) => (s === id ? null : s));
    },
    [setNodes, setEdges],
  );

  const updateData = useCallback(
    (id: string, patch: Partial<NbtData>) => {
      setNodes((ns) =>
        ns.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, ...patch } } : n,
        ),
      );
    },
    [setNodes],
  );

  // ----- copy / cut / paste / duplicate -----
  const selectionClip = useCallback((): Clip | null => {
    const sel = nodesRef.current.filter((n) => n.selected);
    if (!sel.length) return null;
    const idx = new Map(sel.map((n, i) => [n.id, i]));
    return {
      nodes: sel.map((n) => ({
        data: n.data as unknown as NbtData,
        x: n.position.x,
        y: n.position.y,
      })),
      edges: edgesRef.current
        .filter((e) => idx.has(e.source) && idx.has(e.target))
        .map((e) => [idx.get(e.source)!, idx.get(e.target)!]),
    };
  }, []);

  const placeClip = useCallback(
    (clip: Clip, target: { x: number; y: number }) => {
      if (!clip.nodes.length) return;
      const minx = Math.min(...clip.nodes.map((n) => n.x));
      const miny = Math.min(...clip.nodes.map((n) => n.y));
      const ids = nextIds(clip.nodes.length);
      const created: Node[] = clip.nodes.map((cn, i) => ({
        id: ids[i],
        type: "nbt",
        position: { x: target.x + (cn.x - minx), y: target.y + (cn.y - miny) },
        data: { ...cn.data } as unknown as Record<string, unknown>,
        selected: true,
      }));
      const ts = Date.now();
      const newEdges: Edge[] = clip.edges.map(([a, b], i) => ({
        id: `e-${ts}-${i}`,
        source: ids[a],
        target: ids[b],
        sourceHandle: "out",
        targetHandle: "in",
      }));
      setNodes((ns) => [
        ...ns.map((n) => ({ ...n, selected: false })),
        ...created,
      ]);
      setEdges((es) => [...es, ...newEdges]);
    },
    [nextIds, setNodes, setEdges],
  );

  const copySelection = useCallback(() => {
    const clip = selectionClip();
    if (!clip) return false;
    writeClip(clip);
    return true;
  }, [selectionClip]);

  const cutSelection = useCallback(() => {
    if (!copySelection()) return;
    const sel = new Set(
      nodesRef.current.filter((n) => n.selected).map((n) => n.id),
    );
    setNodes((ns) => ns.filter((n) => !sel.has(n.id)));
    setEdges((es) =>
      es.filter((e) => !sel.has(e.source) && !sel.has(e.target)),
    );
    setPanelId(null);
  }, [copySelection, setNodes, setEdges]);

  const paste = useCallback(() => {
    const clip = readClip();
    if (!clip) return;
    const c = viewportCenter();
    placeClip(clip, { x: c.x - 70, y: c.y - 15 });
  }, [placeClip, viewportCenter]);

  const duplicateSelection = useCallback(() => {
    const clip = selectionClip();
    if (!clip) return;
    const minx = Math.min(...clip.nodes.map((n) => n.x));
    const miny = Math.min(...clip.nodes.map((n) => n.y));
    placeClip(clip, { x: minx + 30, y: miny + 30 });
  }, [selectionClip, placeClip]);

  // ----- auto-layout (longest-path layered) + fit -----
  const fitView = useCallback(
    () => rf.fitView({ padding: 0.2, duration: 200 }),
    [rf],
  );

  const autoLayout = useCallback(() => {
    const ns = nodesRef.current;
    if (!ns.length) return;
    const pos = new Map(ns.map((n) => [n.id, n.position]));
    const parents = new Map<string, string[]>();
    ns.forEach((n) => parents.set(n.id, []));
    edgesRef.current.forEach((e) => {
      if (parents.has(e.target) && parents.has(e.source)) {
        parents.get(e.target)!.push(e.source);
      }
    });
    const layer = new Map<string, number>();
    const visiting = new Set<string>();
    const calc = (id: string): number => {
      if (layer.has(id)) return layer.get(id)!;
      if (visiting.has(id)) return 0; // cycle guard
      visiting.add(id);
      const ps = parents.get(id)!;
      const v = ps.length ? Math.max(...ps.map(calc)) + 1 : 0;
      visiting.delete(id);
      layer.set(id, v);
      return v;
    };
    ns.forEach((n) => calc(n.id));
    const byLayer = new Map<number, string[]>();
    ns.forEach((n) => {
      const L = layer.get(n.id)!;
      if (!byLayer.has(L)) byLayer.set(L, []);
      byLayer.get(L)!.push(n.id);
    });
    const colGap = 200;
    const rowGap = 90;
    const placed = new Map<string, { x: number; y: number }>();
    let x = 40;
    const maxL = Math.max(...layer.values());
    for (let L = 0; L <= maxL; L++) {
      const col = byLayer.get(L) || [];
      col.sort((a, b) => (pos.get(a)?.y || 0) - (pos.get(b)?.y || 0));
      let y = 40;
      col.forEach((id) => {
        placed.set(id, { x, y });
        y += rowGap;
      });
      x += colGap;
    }
    setNodes((prev) =>
      prev.map((n) =>
        placed.has(n.id) ? { ...n, position: placed.get(n.id)! } : n,
      ),
    );
    setTimeout(fitView, 60);
  }, [setNodes, fitView]);

  // expose the shim (toolbar / palette / tab bar / save)
  useEffect(() => {
    activeGraphRef.current = {
      exportGraph: () =>
        flowToGraph(nodesRef.current, edgesRef.current, metas),
      addNode: addNodeOfType,
      undo,
      redo,
      autoLayout,
      fitView,
    };
    return () => {
      activeGraphRef.current = null;
    };
  }, [addNodeOfType, undo, redo, autoLayout, fitView, metas]);

  // load the active flow's graph (clear when none)
  useEffect(() => {
    if (metas.length === 0) return;
    if (!activeFlowId) {
      setNodes([]);
      setEdges([]);
      setPanelId(null);
      loadedFlow.current = null;
      activeGraphRef.flowId = null;
      initHistory([], []);
      return;
    }
    if (loadedFlow.current === activeFlowId) return;
    let cancelled = false;
    const target = activeFlowId;
    activeGraphRef.flowId = null;
    api
      .getFlow(target)
      .then((flow) => {
        if (cancelled) return;
        const { nodes: n, edges: e } = graphToFlow(flow.graph, metas);
        setNodes(n);
        setEdges(e);
        setPanelId(null);
        loadedFlow.current = target;
        activeGraphRef.flowId = target;
        initHistory(n, e);
        setTimeout(() => rf.fitView({ padding: 0.2, duration: 200 }), 60);
      })
      .catch((err) => message.error((err as Error).message));
    return () => {
      cancelled = true;
    };
  }, [activeFlowId, metas, setNodes, setEdges, rf, message, initHistory]);

  // keep the store's "has a trigger?" flag in sync (drives Listen vs Run)
  useEffect(() => {
    setFlowHasTrigger(
      nodes.some((n) => (n.data as unknown as NbtData).isTrigger),
    );
  }, [nodes, setFlowHasTrigger]);

  const onConnect = useCallback(
    (c: Connection) =>
      setEdges((es) =>
        addEdge({ ...c, sourceHandle: "out", targetHandle: "in" }, es),
      ),
    [setEdges],
  );

  // open the property panel on double-click only (single click just selects)
  const onNodeDoubleClick = useCallback((_e: unknown, node: Node) => {
    setPanelId(node.id);
  }, []);

  // keyboard: undo/redo, copy/cut/paste, duplicate, save (ignored while typing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // only act while the editor canvas is the active view
      const v = useStore.getState().view;
      if (v !== "workflow" && v !== "nodes") return;
      const t = e.target as HTMLElement | null;
      const tag = t?.localName;
      if (tag === "input" || tag === "textarea" || t?.isContentEditable) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (!mod) return;
      if (k === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (k === "y") {
        e.preventDefault();
        redo();
      } else if (k === "c") {
        if (copySelection()) e.preventDefault();
      } else if (k === "x") {
        cutSelection();
      } else if (k === "v") {
        paste();
      } else if (k === "d") {
        e.preventDefault();
        duplicateSelection();
      } else if (k === "s") {
        e.preventDefault();
        const fid = activeGraphRef.flowId;
        if (!fid || !activeGraphRef.current) return;
        api
          .saveGraph(fid, activeGraphRef.current.exportGraph())
          .then(() => message.success("Saved"))
          .catch((err) => message.error((err as Error).message));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, copySelection, cutSelection, paste, duplicateSelection, message]);

  const panelNode = nodes.find((n) => n.id === panelId) || null;
  const panelMeta = panelNode
    ? metaByType[(panelNode.data as unknown as NbtData).nbtType]
    : undefined;

  return (
    <div className="nbt-flow-wrap" ref={wrapRef}>
      <div className="nbt-flow-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDoubleClick={onNodeDoubleClick}
          colorMode="dark"
          fitView
          deleteKeyCode={["Delete"]}
          multiSelectionKeyCode={["Shift", "Meta", "Control"]}
          minZoom={0.2}
          maxZoom={2}
        >
          <Background gap={18} />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
        {metas.length === 0 && (
          <div className="nbt-flow-overlay">
            <Spin tip="Loading node types…" />
          </div>
        )}
        {metas.length > 0 && !activeFlowId && (
          <div className="nbt-flow-overlay">
            <Empty
              description="Open or create a workflow from the sidebar"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          </div>
        )}
      </div>

      {panelNode && (
        <PropertyPanel
          node={panelNode}
          meta={panelMeta}
          onChange={(patch) => updateData(panelNode.id, patch)}
          onEditCode={(req) => setEdit(req)}
          onDelete={() => deleteNode(panelNode.id)}
          onClose={() => setPanelId(null)}
        />
      )}

      {edit && (
        <Suspense fallback={null}>
          <ValueEditorModal
            open
            title={edit.title}
            initialValue={edit.value}
            onSave={(v) => {
              edit.apply(v);
              setEdit(null);
            }}
            onCancel={() => setEdit(null)}
          />
        </Suspense>
      )}
    </div>
  );
}

export default function GraphEditor() {
  return (
    <ReactFlowProvider>
      <Editor />
    </ReactFlowProvider>
  );
}

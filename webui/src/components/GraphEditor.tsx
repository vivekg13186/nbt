import { useEffect, useRef, useState } from "react";
import { App as AntApp, Empty, Spin } from "antd";
import { useStore } from "../store";
import { api } from "../api";
import { NbtGraph } from "../graph/nbtGraph";
import { activeGraphRef } from "../graph/active";
import ValueEditorModal from "./ValueEditorModal";

interface EditReq {
  title: string;
  value: string;
  apply: (v: string) => void;
}

export default function GraphEditor() {
  const { message } = AntApp.useApp();
  const nodes = useStore((s) => s.nodes);
  const activeFlowId = useStore((s) => s.activeFlowId);
  const setFlowHasTrigger = useStore((s) => s.setFlowHasTrigger);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gRef = useRef<NbtGraph | null>(null);
  const loadedFlow = useRef<string | null>(null);
  const [edit, setEdit] = useState<EditReq | null>(null);

  // Build the controller once node metadata is available.
  useEffect(() => {
    if (!canvasRef.current || nodes.length === 0 || gRef.current) return;
    const g = new NbtGraph(canvasRef.current, nodes);
    gRef.current = g;
    activeGraphRef.current = g;
    activeGraphRef.flowId = null;
    g.onEdit = (req) => setEdit(req);
    g.onGraphChange = () => setFlowHasTrigger(g.hasTrigger());
    g.setTheme(true);
    g.resize();

    const ro = new ResizeObserver(() => g.resize());
    if (wrapRef.current) ro.observe(wrapRef.current);
    // Re-run HiDPI sizing on window resize / DPI change (e.g. moving the
    // window to a monitor with a different devicePixelRatio).
    const onWin = () => g.resize();
    window.addEventListener("resize", onWin);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onWin);
      g.destroy();
      gRef.current = null;
      if (activeGraphRef.current === g) {
        activeGraphRef.current = null;
        activeGraphRef.flowId = null;
      }
    };
  }, [nodes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load the active flow's graph whenever it changes (and clear when none).
  useEffect(() => {
    const g = gRef.current;
    if (!g) return;

    // no flow open (e.g. all tabs closed): clear the canvas
    if (!activeFlowId) {
      g.importGraph({ nodes: [], links: [] });
      loadedFlow.current = null;
      activeGraphRef.flowId = null;
      return;
    }
    if (loadedFlow.current === activeFlowId) return;

    let cancelled = false;
    const target = activeFlowId;
    // canvas no longer matches a saved flow while loading -> block saves
    activeGraphRef.flowId = null;
    api
      .getFlow(target)
      .then((flow) => {
        if (cancelled) return;
        g.importGraph(flow.graph);
        g.resize();
        loadedFlow.current = target;
        activeGraphRef.flowId = target; // canvas now shows this flow
      })
      .catch((e) => message.error((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [activeFlowId, nodes, message]);

  return (
    <div className="nbt-canvas-wrap" ref={wrapRef}>
      <canvas ref={canvasRef} />
      {nodes.length === 0 && (
        <div className="nbt-empty">
          <Spin tip="Loading node types…" />
        </div>
      )}
      {nodes.length > 0 && !activeFlowId && (
        <div className="nbt-empty">
          <Empty
            description="Open or create a workflow from the sidebar"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        </div>
      )}
      <ValueEditorModal
        open={!!edit}
        title={edit?.title ?? ""}
        initialValue={edit?.value ?? ""}
        onSave={(v) => {
          edit?.apply(v);
          setEdit(null);
        }}
        onCancel={() => setEdit(null)}
      />
    </div>
  );
}

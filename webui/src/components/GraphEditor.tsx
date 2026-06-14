import { useEffect, useRef } from "react";
import { App as AntApp, Empty, Spin } from "antd";
import { useStore } from "../store";
import { api } from "../api";
import { NbtGraph } from "../graph/nbtGraph";
import { activeGraphRef } from "../graph/active";

export default function GraphEditor() {
  const { message } = AntApp.useApp();
  const nodes = useStore((s) => s.nodes);
  const activeFlowId = useStore((s) => s.activeFlowId);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gRef = useRef<NbtGraph | null>(null);
  const loadedFlow = useRef<string | null>(null);

  // Build the controller once node metadata is available.
  useEffect(() => {
    if (!canvasRef.current || nodes.length === 0 || gRef.current) return;
    const g = new NbtGraph(canvasRef.current, nodes);
    gRef.current = g;
    activeGraphRef.current = g;
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
      if (activeGraphRef.current === g) activeGraphRef.current = null;
    };
  }, [nodes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load the active flow's graph whenever it changes.
  useEffect(() => {
    const g = gRef.current;
    if (!g || !activeFlowId || loadedFlow.current === activeFlowId) return;
    let cancelled = false;
    api
      .getFlow(activeFlowId)
      .then((flow) => {
        if (cancelled) return;
        g.importGraph(flow.graph);
        g.resize();
        loadedFlow.current = activeFlowId;
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
    </div>
  );
}

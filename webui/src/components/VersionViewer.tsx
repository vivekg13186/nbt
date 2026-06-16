import { useEffect, useRef } from "react";
import { Button, Modal, Space, Tag } from "antd";
import { Download, Play } from "lucide-react";
import { NbtGraph } from "../graph/nbtGraph";
import { useStore } from "../store";
import type { FlowVersionDetail } from "../types";

export default function VersionViewer({
  version,
  flowName,
  onClose,
  onRun,
  onExport,
}: {
  version: FlowVersionDetail | null;
  flowName: string;
  onClose: () => void;
  onRun: () => void;
  onExport: () => void;
}) {
  const nodes = useStore((s) => s.nodes);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gRef = useRef<NbtGraph | null>(null);

  useEffect(() => {
    if (!version || !canvasRef.current || nodes.length === 0) return;
    const g = new NbtGraph(canvasRef.current, nodes, {
      readOnly: true,
      reuseTypes: true, // reuse the main editor's globally-registered classes
    });
    gRef.current = g;
    g.setTheme(true);
    g.resize();
    g.importGraph(version.graph);
    // fit after the modal has laid out
    const t = setTimeout(() => g.resize(), 60);
    const ro = new ResizeObserver(() => g.resize());
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => {
      clearTimeout(t);
      ro.disconnect();
      g.destroy();
      gRef.current = null;
    };
  }, [version, nodes]);

  return (
    <Modal
      open={!!version}
      onCancel={onClose}
      width={920}
      destroyOnClose
      afterOpenChange={(o) => {
        if (o) {
          gRef.current?.resize();
          gRef.current?.canvas.setDirty(true, true);
        }
      }}
      title={
        <Space>
          <span>{flowName}</span>
          {version && <Tag color="default">v{version.version}</Tag>}
          {version?.label && <span style={{ opacity: 0.7 }}>{version.label}</span>}
          <Tag>read-only</Tag>
        </Space>
      }
      footer={[
        <Button key="export" icon={<Download size={14} />} onClick={onExport}>
          Export
        </Button>,
        <Button
          key="run"
          type="primary"
          icon={<Play size={14} />}
          onClick={onRun}
        >
          Run
        </Button>,
        <Button key="close" onClick={onClose}>
          Close
        </Button>,
      ]}
    >
      <div
        ref={wrapRef}
        style={{
          height: "60vh",
          position: "relative",
          border: "1px solid var(--nbt-border)",
          borderRadius: 6,
          overflow: "hidden",
        }}
      >
        <canvas ref={canvasRef} style={{ display: "block" }} />
      </div>
    </Modal>
  );
}

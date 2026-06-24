import { useMemo } from "react";
import { Button, Modal, Space, Tag } from "antd";
import { Download, Play } from "lucide-react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useStore } from "../store";
import { graphToFlow } from "../flow/serialize";
import NbtNode from "./NbtNode";
import type { FlowVersionDetail } from "../types";

const nodeTypes = { nbt: NbtNode };

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
  const metas = useStore((s) => s.nodes);
  const { nodes, edges } = useMemo(
    () =>
      version ? graphToFlow(version.graph, metas) : { nodes: [], edges: [] },
    [version, metas],
  );

  return (
    <Modal
      open={!!version}
      onCancel={onClose}
      width={920}
      destroyOnClose
      title={
        <Space>
          <span>{flowName}</span>
          {version && <Tag color="default">v{version.version}</Tag>}
          {version?.label && (
            <span style={{ opacity: 0.7 }}>{version.label}</span>
          )}
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
        style={{
          height: "60vh",
          position: "relative",
          border: "1px solid var(--nbt-border)",
          borderRadius: 6,
          overflow: "hidden",
        }}
      >
        <ReactFlow
          key={version?.id}
          defaultNodes={nodes}
          defaultEdges={edges}
          nodeTypes={nodeTypes}
          colorMode="dark"
          fitView
          fitViewOptions={{ padding: 0.2 }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          onInit={(inst: ReactFlowInstance) =>
            setTimeout(() => inst.fitView({ padding: 0.2 }), 60)
          }
        >
          <Background gap={18} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
    </Modal>
  );
}

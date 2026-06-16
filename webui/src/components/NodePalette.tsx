import { useMemo, useState } from "react";
import { App as AntApp, Empty, Input, Tag } from "antd";
import {
  Box,
  Braces,
  CircleCheckBig,
  Clock,
  Code,
  FileCheck,
  FilePlus,
  FileSearch,
  FileText,
  Folder,
  Globe,
  Image,
  ScrollText,
  Search,
  SquareCode,
  Trash2,
  Variable,
  Workflow,
  Zap,
} from "lucide-react";
import { useStore } from "../store";
import { activeGraphRef } from "../graph/active";
import type { NodeMeta } from "../types";

function iconFor(m: NodeMeta) {
  if (m.is_trigger) return <Zap size={16} color="#faad14" />;
  switch (m.type) {
    case "http_request":
      return <Globe size={16} />;
    case "python_eval":
      return <Code size={16} />;
    case "delay":
      return <Clock size={16} />;
    case "set_value":
      return <Variable size={16} />;
    case "assert_equals":
      return <CircleCheckBig size={16} />;
    case "file_watch_trigger":
      return <FileSearch size={16} />;
    case "log":
      return <ScrollText size={16} />;
    case "read_file":
      return <FileText size={16} />;
    case "write_file":
      return <FilePlus size={16} />;
    case "append_file":
      return <FilePlus size={16} />;
    case "read_json":
    case "write_json":
      return <Braces size={16} />;
    case "list_dir":
      return <Folder size={16} />;
    case "file_exists":
      return <FileCheck size={16} />;
    case "delete_file":
      return <Trash2 size={16} />;
    case "display_code":
      return <SquareCode size={16} />;
    case "show_image":
      return <Image size={16} />;
    case "subflow":
      return <Workflow size={16} />;
    default:
      return <Box size={16} />;
  }
}

export default function NodePalette() {
  const { message } = AntApp.useApp();
  const nodes = useStore((s) => s.nodes);
  const activeFlowId = useStore((s) => s.activeFlowId);
  const [q, setQ] = useState("");

  const groups = useMemo(() => {
    const filtered = nodes.filter(
      (n) =>
        n.label.toLowerCase().includes(q.toLowerCase()) ||
        n.type.toLowerCase().includes(q.toLowerCase()) ||
        n.category.toLowerCase().includes(q.toLowerCase()),
    );
    const out: Record<string, NodeMeta[]> = {};
    filtered.forEach((n) => (out[n.category] ||= []).push(n));
    return Object.entries(out).sort((a, b) => a[0].localeCompare(b[0]));
  }, [nodes, q]);

  function add(m: NodeMeta) {
    if (!activeFlowId) {
      message.warning("Open a workflow first");
      return;
    }
    if (!activeGraphRef.current) return;
    activeGraphRef.current.addNode(m.type);
    message.success(`Added ${m.label}`);
  }

  return (
    <div className="nbt-sidebar">
      <div className="nbt-sidebar-head">
        <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          <strong style={{ flex: 1 }}>Nodes</strong>
          <Tag>{nodes.length}</Tag>
        </div>
        <Input
          size="small"
          placeholder="Search nodes"
          prefix={<Search size={14} />}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          allowClear
        />
        <div style={{ fontSize: 11, color: "var(--nbt-muted)", marginTop: 6 }}>
          Click a node to add it to the canvas.
        </div>
      </div>
      <div className="nbt-sidebar-list">
        {groups.length === 0 && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
        {groups.map(([cat, list]) => (
          <div key={cat} style={{ marginBottom: 8 }}>
            <div
              style={{
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                color: "var(--nbt-muted)",
                padding: "6px 10px 2px",
              }}
            >
              {cat}
            </div>
            {list.map((m) => (
              <div
                key={m.type}
                onClick={() => add(m)}
                title={`Add ${m.label}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "7px 10px",
                  borderRadius: 6,
                  cursor: "pointer",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = "var(--nbt-hover)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "transparent")
                }
              >
                <span style={{ width: 18, textAlign: "center" }}>
                  {iconFor(m)}
                </span>
                <span style={{ flex: 1 }}>{m.label}</span>
                {m.is_trigger && (
                  <Tag color="warning" style={{ marginInlineEnd: 0 }}>
                    trigger
                  </Tag>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

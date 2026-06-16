import { useEffect, useState } from "react";
import {
  App as AntApp,
  Button,
  Descriptions,
  Drawer,
  Space,
  Table,
  Tag,
} from "antd";
import { RefreshCw, Trash2 } from "lucide-react";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { vscodeDark } from "@uiw/codemirror-theme-vscode";
import { api } from "../api";
import type { Execution, ExecutionDetail, ExecutionStep } from "../types";

const statusColor: Record<string, string> = {
  passed: "success",
  failed: "error",
  error: "error",
  running: "processing",
  skipped: "default",
};

function fmt(ts: number | null) {
  return ts ? new Date(ts * 1000).toLocaleString() : "—";
}

function parseOutputs(s: ExecutionStep): Record<string, unknown> {
  try {
    return JSON.parse(s.outputs || "{}");
  } catch {
    return {};
  }
}

// Render a step's detail. Display nodes get a rich view; everything else
// shows raw inputs/outputs.
function renderStepBody(s: ExecutionStep) {
  const out = parseOutputs(s);

  if (s.node_type === "display_code" && typeof out.content === "string") {
    const lang = String(out.language || "text");
    return (
      <div>
        <Tag style={{ marginBottom: 6 }}>{lang}</Tag>
        <div style={{ border: "1px solid var(--nbt-border)", borderRadius: 6 }}>
          <CodeMirror
            value={out.content as string}
            theme={vscodeDark}
            editable={false}
            extensions={lang === "json" ? [json()] : []}
            maxHeight="400px"
          />
        </div>
      </div>
    );
  }

  if (s.node_type === "show_image" && typeof out.src === "string") {
    return (
      <div style={{ textAlign: "center", padding: 8 }}>
        <img
          src={out.src as string}
          alt="output"
          style={{
            maxWidth: "100%",
            maxHeight: 420,
            border: "1px solid var(--nbt-border)",
            borderRadius: 6,
            imageRendering: "auto",
          }}
        />
        {out.format ? (
          <div style={{ fontSize: 11, color: "var(--nbt-muted)", marginTop: 4 }}>
            {String(out.format)}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <pre style={{ fontSize: 11, margin: 0, whiteSpace: "pre-wrap" }}>
      inputs: {s.inputs || "{}"}
      {"\n"}outputs: {s.outputs || "{}"}
      {s.error ? "\nerror: " + s.error : ""}
    </pre>
  );
}

export default function RunsPage() {
  const { message, modal } = AntApp.useApp();
  const [rows, setRows] = useState<Execution[]>([]);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<ExecutionDetail | null>(null);

  async function load() {
    setLoading(true);
    try {
      setRows(await api.listExecutions());
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function openDetail(id: string) {
    setDetail(await api.getExecution(id));
  }

  const columns = [
    {
      title: "Status",
      dataIndex: "status",
      render: (s: string) => <Tag color={statusColor[s]}>{s}</Tag>,
    },
    { title: "Workflow", dataIndex: "flow_name" },
    {
      title: "Env",
      dataIndex: "environment",
      render: (e: string | null) =>
        e ? <Tag>{e}</Tag> : <span style={{ opacity: 0.4 }}>—</span>,
    },
    {
      title: "Started",
      dataIndex: "started_at",
      render: (t: number) => fmt(t),
    },
    {
      title: "Duration",
      key: "dur",
      render: (_: unknown, r: Execution) =>
        r.finished_at
          ? `${(r.finished_at - r.started_at).toFixed(2)}s`
          : "…",
    },
  ];

  const stepCols = [
    {
      title: "Status",
      dataIndex: "status",
      render: (s: string) => <Tag color={statusColor[s]}>{s}</Tag>,
    },
    { title: "Node", dataIndex: "node_name" },
    { title: "Type", dataIndex: "node_type" },
    {
      title: "Outputs",
      dataIndex: "outputs",
      render: (o: string | null) => (
        <code style={{ fontSize: 11 }}>{o || "—"}</code>
      ),
    },
    {
      title: "Error",
      dataIndex: "error",
      render: (e: string | null) =>
        e ? (
          <span style={{ color: "#ff4d4f", fontSize: 11 }}>
            {e.split("\n")[0]}
          </span>
        ) : (
          "—"
        ),
    },
  ];

  return (
    <div className="nbt-editor-pane">
      <Space style={{ marginBottom: 12 }}>
        <strong style={{ fontSize: 16 }}>Executions</strong>
        <Button size="small" icon={<RefreshCw size={14} />} onClick={load}>
          Refresh
        </Button>
        <Button
          size="small"
          danger
          icon={<Trash2 size={14} />}
          onClick={() =>
            modal.confirm({
              title: "Clear all execution history?",
              okType: "danger",
              onOk: async () => {
                await api.clearExecutions();
                load();
              },
            })
          }
        >
          Clear
        </Button>
      </Space>
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        onRow={(r) => ({ onClick: () => openDetail(r.id) })}
        pagination={{ pageSize: 20 }}
        style={{ cursor: "pointer" }}
      />

      <Drawer
        title="Execution detail"
        width={720}
        open={!!detail}
        onClose={() => setDetail(null)}
      >
        {detail && (
          <>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="Workflow">
                {detail.flow_name}
              </Descriptions.Item>
              <Descriptions.Item label="Status">
                <Tag color={statusColor[detail.status]}>{detail.status}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Environment">
                {detail.environment || "—"}
              </Descriptions.Item>
              <Descriptions.Item label="Started">
                {fmt(detail.started_at)}
              </Descriptions.Item>
              {detail.error && (
                <Descriptions.Item label="Error">
                  <span style={{ color: "#ff4d4f" }}>{detail.error}</span>
                </Descriptions.Item>
              )}
            </Descriptions>
            <Table
              style={{ marginTop: 16 }}
              rowKey="id"
              size="small"
              columns={stepCols}
              dataSource={detail.steps}
              pagination={false}
              expandable={{
                expandedRowRender: (s: ExecutionStep) => renderStepBody(s),
              }}
            />
          </>
        )}
      </Drawer>
    </div>
  );
}

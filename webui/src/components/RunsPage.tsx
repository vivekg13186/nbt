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
import { RefreshCw, Square, Trash2 } from "lucide-react";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { vscodeDark } from "@uiw/codemirror-theme-vscode";
import type { Extension } from "@codemirror/state";
import { api } from "../api";
import type { Execution, ExecutionDetail, ExecutionStep } from "../types";

function langExt(lang: string): Extension[] {
  switch (lang) {
    case "json":
      return [json()];
    case "html":
      return [html()];
    case "javascript":
    case "js":
      return [javascript()];
    case "python":
    case "py":
      return [python()];
    default:
      return [];
  }
}

const statusColor: Record<string, string> = {
  passed: "success",
  failed: "error",
  error: "error",
  running: "processing",
  cancelled: "warning",
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
            extensions={langExt(lang)}
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

  async function cancelRun(id: string) {
    try {
      await api.cancelExecution(id);
      message.info("Stopping run…");
      setTimeout(load, 600); // give the engine a moment to settle the status
    } catch (e) {
      message.error((e as Error).message);
    }
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
    {
      title: "",
      key: "actions",
      render: (_: unknown, r: Execution) =>
        r.status === "running" ? (
          <Button
            size="small"
            danger
            icon={<Square size={12} />}
            onClick={(e) => {
              e.stopPropagation();
              cancelRun(r.id);
            }}
          >
            Stop
          </Button>
        ) : null,
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
            {detail.context && Object.keys(detail.context).length > 0 && (
              <div style={{ marginTop: 16 }}>
                <strong>Context</strong>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--nbt-muted)",
                    marginBottom: 6,
                  }}
                >
                  Final published variables (node outputs and aliases);
                  environment variables are not included.
                </div>
                <div
                  style={{
                    border: "1px solid var(--nbt-border)",
                    borderRadius: 6,
                    overflow: "hidden",
                  }}
                >
                  <CodeMirror
                    value={JSON.stringify(detail.context, null, 2)}
                    theme={vscodeDark}
                    editable={false}
                    extensions={[json()]}
                    maxHeight="320px"
                  />
                </div>
              </div>
            )}
          </>
        )}
      </Drawer>
    </div>
  );
}

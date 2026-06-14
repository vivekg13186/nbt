import { useEffect, useState } from "react";
import { App as AntApp, Button, Empty, Space, Table, Tag } from "antd";
import { RefreshCw, Square } from "lucide-react";
import { useStore } from "../store";
import { api } from "../api";
import type { ListenerStat } from "../types";

export default function ListenersPage() {
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<ListenerStat[]>([]);
  const [loading, setLoading] = useState(false);
  const setActiveFlow = useStore((s) => s.setActiveFlow);
  const openFlow = useStore((s) => s.openFlow);

  async function load() {
    setLoading(true);
    try {
      setRows(await api.listeners());
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // Poll while listeners are active (live stats).
  useEffect(() => {
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function stop(flowId: string) {
    await api.stopListen(flowId);
    load();
  }
  async function stopAll() {
    await api.stopAllListen();
    load();
  }

  const columns = [
    {
      title: "Workflow",
      dataIndex: "flow_name",
      render: (name: string, r: ListenerStat) => (
        <a
          onClick={() => {
            openFlow(r.flow_id);
            setActiveFlow(r.flow_id);
          }}
        >
          {name}
        </a>
      ),
    },
    {
      title: "Env",
      dataIndex: "environment",
      render: (e: string | null) =>
        e ? <Tag>{e}</Tag> : <span style={{ opacity: 0.4 }}>—</span>,
    },
    {
      title: "Status",
      dataIndex: "active",
      render: (a: boolean) =>
        a ? <Tag color="processing">listening</Tag> : <Tag>stopped</Tag>,
    },
    { title: "Events", dataIndex: "events" },
    { title: "Runs", dataIndex: "runs" },
    { title: "Filtered", dataIndex: "filtered" },
    { title: "Busy-skips", dataIndex: "skipped_busy" },
    {
      title: "Last result",
      dataIndex: "last_status",
      render: (s: string | null) =>
        s ? (
          <Tag color={s === "passed" ? "success" : "error"}>{s}</Tag>
        ) : (
          <span style={{ opacity: 0.4 }}>—</span>
        ),
    },
    {
      title: "",
      key: "actions",
      render: (_: unknown, r: ListenerStat) => (
        <Button
          danger
          size="small"
          icon={<Square size={14} />}
          onClick={() => stop(r.flow_id)}
        >
          Stop
        </Button>
      ),
    },
  ];

  return (
    <div className="nbt-editor-pane">
      <Space style={{ marginBottom: 12 }}>
        <strong style={{ fontSize: 16 }}>Active listeners</strong>
        <Tag>{rows.length}</Tag>
        <Button size="small" icon={<RefreshCw size={14} />} onClick={load}>
          Refresh
        </Button>
        <Button
          size="small"
          danger
          icon={<Square size={14} />}
          disabled={rows.length === 0}
          onClick={stopAll}
        >
          Stop all
        </Button>
      </Space>
      <Table
        rowKey="flow_id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={false}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No active listeners. Open a trigger workflow and press Listen."
            />
          ),
        }}
      />
    </div>
  );
}

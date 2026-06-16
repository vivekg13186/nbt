import { useEffect, useState } from "react";
import { App as AntApp, Button, Drawer, Empty, Space, Table, Tag } from "antd";
import { Download, Eye, Play, Trash2 } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import VersionViewer from "./VersionViewer";
import type { FlowVersion, FlowVersionDetail } from "../types";

function downloadGraph(name: string, graph: unknown) {
  const blob = new Blob([JSON.stringify(graph, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function VersionsDrawer({
  flowId,
  flowName,
  open,
  onClose,
}: {
  flowId: string | null;
  flowName: string;
  open: boolean;
  onClose: () => void;
}) {
  const { message, modal } = AntApp.useApp();
  const activeEnv = useStore((s) => s.activeEnvName);
  const openBottom = useStore((s) => s.openBottom);
  const [rows, setRows] = useState<FlowVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewing, setViewing] = useState<FlowVersionDetail | null>(null);

  async function load() {
    if (!flowId) return;
    setLoading(true);
    try {
      setRows(await api.listVersions(flowId));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) load();
  }, [open, flowId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(v: FlowVersion) {
    openBottom("log");
    try {
      const r = await api.runVersion(v.id, activeEnv);
      if (r.status === "passed") message.success(`v${v.version} passed`);
      else message.error(`v${v.version} ${r.status}`);
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  async function exportVersion(v: FlowVersion) {
    try {
      const d = await api.getVersion(v.id);
      downloadGraph(`${flowName}-v${v.version}.json`, d.graph);
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  function del(v: FlowVersion) {
    modal.confirm({
      title: `Delete snapshot v${v.version}?`,
      okType: "danger",
      okText: "Delete",
      onOk: async () => {
        await api.deleteVersion(v.id);
        load();
      },
    });
  }

  const columns = [
    {
      title: "Version",
      dataIndex: "version",
      width: 90,
      render: (v: number) => <Tag>v{v}</Tag>,
    },
    {
      title: "Label",
      dataIndex: "label",
      render: (l: string | null) =>
        l || <span style={{ opacity: 0.4 }}>—</span>,
    },
    {
      title: "Taken",
      dataIndex: "created_at",
      render: (t: number) => new Date(t * 1000).toLocaleString(),
    },
    {
      title: "",
      key: "actions",
      render: (_: unknown, v: FlowVersion) => (
        <Space>
          <Button
            size="small"
            icon={<Eye size={13} />}
            onClick={async () => {
              try {
                setViewing(await api.getVersion(v.id));
              } catch (e) {
                message.error((e as Error).message);
              }
            }}
          >
            View
          </Button>
          <Button size="small" icon={<Play size={13} />} onClick={() => run(v)}>
            Run
          </Button>
          <Button
            size="small"
            icon={<Download size={13} />}
            onClick={() => exportVersion(v)}
          />
          <Button
            size="small"
            danger
            icon={<Trash2 size={13} />}
            onClick={() => del(v)}
          />
        </Space>
      ),
    },
  ];

  return (
    <Drawer
      title={`Versions — ${flowName}`}
      width={680}
      open={open}
      onClose={onClose}
    >
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={false}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No snapshots yet — use “Snapshot version” on the tab"
            />
          ),
        }}
      />
      <VersionViewer
        version={viewing}
        flowName={flowName}
        onClose={() => setViewing(null)}
        onRun={() => viewing && run(viewing)}
        onExport={() =>
          viewing && downloadGraph(`${flowName}-v${viewing.version}.json`, viewing.graph)
        }
      />
    </Drawer>
  );
}

import { useMemo, useState } from "react";
import { App as AntApp, Button, Empty, Input, Modal } from "antd";
import { Plus, Search } from "lucide-react";
import { useStore } from "../store";
import { api } from "../api";
import NodePalette from "./NodePalette";

export default function Sidebar() {
  const view = useStore((s) => s.view);
  if (view === "nodes") return <NodePalette />;
  if (view === "environment") return <EnvSidebar />;
  return <FlowSidebar />;
}

function FlowSidebar() {
  const { message } = AntApp.useApp();
  const flows = useStore((s) => s.flows);
  const activeFlowId = useStore((s) => s.activeFlowId);
  const openFlow = useStore((s) => s.openFlow);
  const refreshFlows = useStore((s) => s.refreshFlows);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  const list = useMemo(
    () =>
      flows.filter((f) => f.name.toLowerCase().includes(q.toLowerCase())),
    [flows, q],
  );

  async function create() {
    if (!name.trim()) return;
    try {
      const f = await api.createFlow(name.trim(), { nodes: [], links: [] });
      await refreshFlows();
      openFlow(f.id);
      setOpen(false);
      setName("");
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  return (
    <div className="nbt-sidebar">
      <div className="nbt-sidebar-head">
        <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          <strong style={{ flex: 1 }}>Workflows</strong>
          <Button
            size="small"
            type="text"
            icon={<Plus size={15} />}
            onClick={() => setOpen(true)}
          />
        </div>
        <Input
          size="small"
          placeholder="Search"
          prefix={<Search size={14} />}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          allowClear
        />
      </div>
      <div className="nbt-sidebar-list">
        {list.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />}
        {list.map((f) => (
          <div
            key={f.id}
            onClick={() => openFlow(f.id)}
            style={{
              padding: "7px 10px",
              borderRadius: 6,
              cursor: "pointer",
              background:
                f.id === activeFlowId ? "var(--nbt-active)" : "transparent",
              color: f.id === activeFlowId ? "var(--nbt-primary)" : "inherit",
            }}
          >
            {f.name}
          </div>
        ))}
      </div>

      <Modal
        title="New workflow"
        open={open}
        onOk={create}
        onCancel={() => setOpen(false)}
        okText="Create"
      >
        <Input
          placeholder="Workflow name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onPressEnter={create}
          autoFocus
        />
      </Modal>
    </div>
  );
}

function EnvSidebar() {
  const { message, modal } = AntApp.useApp();
  const envs = useStore((s) => s.envs);
  const activeEnvName = useStore((s) => s.activeEnvName);
  const setActiveEnv = useStore((s) => s.setActiveEnv);
  const refreshEnvs = useStore((s) => s.refreshEnvs);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  const list = useMemo(
    () => envs.filter((e) => e.name.toLowerCase().includes(q.toLowerCase())),
    [envs, q],
  );

  async function create() {
    if (!name.trim()) return;
    try {
      await api.createEnv(name.trim(), {});
      await refreshEnvs();
      setActiveEnv(name.trim());
      setOpen(false);
      setName("");
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  return (
    <div className="nbt-sidebar">
      <div className="nbt-sidebar-head">
        <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          <strong style={{ flex: 1 }}>Environments</strong>
          <Button
            size="small"
            type="text"
            icon={<Plus size={15} />}
            onClick={() => setOpen(true)}
          />
        </div>
        <Input
          size="small"
          placeholder="Search"
          prefix={<Search size={14} />}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          allowClear
        />
      </div>
      <div className="nbt-sidebar-list">
        {list.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />}
        {list.map((e) => (
          <div
            key={e.id}
            onClick={() => setActiveEnv(e.name)}
            style={{
              display: "flex",
              alignItems: "center",
              padding: "7px 10px",
              borderRadius: 6,
              cursor: "pointer",
              background:
                e.name === activeEnvName ? "var(--nbt-active)" : "transparent",
              color:
                e.name === activeEnvName ? "var(--nbt-primary)" : "inherit",
            }}
          >
            <span style={{ flex: 1 }}>{e.name}</span>
            <span style={{ opacity: 0.5, fontSize: 11 }}>
              {Object.keys(e.vars).length} vars
            </span>
            <span
              style={{ marginLeft: 8, opacity: 0.5 }}
              onClick={(ev) => {
                ev.stopPropagation();
                modal.confirm({
                  title: `Delete environment "${e.name}"?`,
                  okType: "danger",
                  onOk: async () => {
                    await api.deleteEnv(e.id);
                    await refreshEnvs();
                  },
                });
              }}
            >
              ✕
            </span>
          </div>
        ))}
      </div>

      <Modal
        title="New environment"
        open={open}
        onOk={create}
        onCancel={() => setOpen(false)}
        okText="Create"
      >
        <Input
          placeholder="Environment name (e.g. staging)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onPressEnter={create}
          autoFocus
        />
      </Modal>
    </div>
  );
}

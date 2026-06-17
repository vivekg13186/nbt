import { useState } from "react";
import {
  App as AntApp,
  Button,
  Dropdown,
  Select,
  Space,
  Tag,
  Tooltip,
} from "antd";
import {
  Copy,
  Play,
  Plus,
  Save,
  ScrollText,
  SquareTerminal,
  Zap,
} from "lucide-react";
import { useStore } from "../store";
import { api } from "../api";
import { activeGraphRef } from "../graph/active";

export default function Toolbar() {
  const { message } = AntApp.useApp();
  const flows = useStore((s) => s.flows);
  const nodes = useStore((s) => s.nodes);
  const envs = useStore((s) => s.envs);
  const activeFlowId = useStore((s) => s.activeFlowId);
  const flowHasTrigger = useStore((s) => s.flowHasTrigger);
  const activeEnvName = useStore((s) => s.activeEnvName);
  const setActiveEnv = useStore((s) => s.setActiveEnv);
  const view = useStore((s) => s.view);
  const terminalOpen = useStore((s) => s.terminalOpen);
  const bottomTab = useStore((s) => s.bottomTab);
  const toggleTerminal = useStore((s) => s.toggleTerminal);
  const setBottomTab = useStore((s) => s.setBottomTab);
  const openBottom = useStore((s) => s.openBottom);

  const [busy, setBusy] = useState(false);
  const flow = flows.find((f) => f.id === activeFlowId);

  // Save the flow currently shown on the canvas (not a stale activeFlowId
  // mid-switch), to avoid overwriting another workflow.
  async function save() {
    const g = activeGraphRef.current;
    const fid = activeGraphRef.flowId;
    if (!g || !fid) return;
    await api.saveGraph(fid, g.exportGraph());
  }

  async function onSave() {
    try {
      await save();
      message.success("Saved");
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  async function onRun() {
    if (!activeFlowId) return;
    setBusy(true);
    openBottom("log");
    try {
      await save();
      const r = await api.runFlow(activeFlowId, activeEnvName);
      if (r.status === "passed") message.success("Run passed");
      else message.error(`Run ${r.status}${r.error ? ": " + r.error : ""}`);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onListen() {
    if (!activeFlowId) return;
    openBottom("log");
    try {
      await save();
      await api.startListen(activeFlowId, activeEnvName);
      message.success("Listening");
      useStore.getState().setView("listeners");
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  function addNode(type: string) {
    activeGraphRef.current?.addNode(type);
  }

  const addItems = {
    items: Object.entries(
      nodes.reduce<Record<string, typeof nodes>>((acc, n) => {
        (acc[n.category] ||= []).push(n);
        return acc;
      }, {}),
    ).map(([cat, list]) => ({
      key: cat,
      label: cat,
      children: list.map((n) => ({
        key: n.type,
        label: n.label + (n.is_trigger ? " ⚡" : ""),
      })),
    })),
    onClick: ({ key }: { key: string }) => addNode(key),
  };

  return (
    <div className="nbt-toolbar">
      <span style={{ fontWeight: 600, minWidth: 0 }}>
        {flow ? flow.name : <span style={{ opacity: 0.5 }}>No workflow open</span>}
      </span>
      {flow && (
        <Tooltip title="Copy name">
          <Button
            type="text"
            size="small"
            icon={<Copy size={14} />}
            onClick={() => {
              navigator.clipboard
                .writeText(flow.name)
                .then(() => message.success("Name copied"))
                .catch(() => message.error("Copy failed"));
            }}
          />
        </Tooltip>
      )}
      {flow && (
        <Tag color="default" style={{ marginLeft: 4 }}>
          {flow.id}
        </Tag>
      )}

      <div style={{ flex: 1 }} />

      {(view === "workflow" || view === "nodes") && (
        <Dropdown menu={addItems} trigger={["click"]} disabled={!flow}>
          <Button size="small" icon={<Plus size={15} />}>
            Add node
          </Button>
        </Dropdown>
      )}

      <Space.Compact>
        <Tooltip title="Environment for run / listen">
          <Select
            size="small"
            style={{ width: 150 }}
            placeholder="(no env)"
            allowClear
            value={activeEnvName ?? undefined}
            onChange={(v) => setActiveEnv(v ?? null)}
            options={envs.map((e) => ({ value: e.name, label: e.name }))}
          />
        </Tooltip>
      </Space.Compact>

      <Button
        size="small"
        icon={<Save size={15} />}
        onClick={onSave}
        disabled={!flow}
      >
        Save
      </Button>
      {flowHasTrigger ? (
        <Button
          type="primary"
          size="small"
          icon={<Zap size={15} />}
          onClick={onListen}
          disabled={!flow}
        >
          Listen
        </Button>
      ) : (
        <Button
          type="primary"
          size="small"
          icon={<Play size={15} />}
          loading={busy}
          onClick={onRun}
          disabled={!flow}
        >
          Run
        </Button>
      )}

      <Tooltip title="Show log">
        <Button
          size="small"
          type={
            terminalOpen && bottomTab === "log" ? "primary" : "default"
          }
          ghost={terminalOpen && bottomTab === "log"}
          icon={<ScrollText size={15} />}
          onClick={() => {
            if (terminalOpen && bottomTab === "log") toggleTerminal();
            else openBottom("log");
          }}
        />
      </Tooltip>
      <Tooltip title="Toggle shell">
        <Button
          size="small"
          type={
            terminalOpen && bottomTab === "shell" ? "primary" : "default"
          }
          ghost={terminalOpen && bottomTab === "shell"}
          icon={<SquareTerminal size={15} />}
          onClick={() => {
            if (terminalOpen && bottomTab === "shell") toggleTerminal();
            else {
              setBottomTab("shell");
              openBottom("shell");
            }
          }}
        />
      </Tooltip>
    </div>
  );
}

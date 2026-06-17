import { useState } from "react";
import {
  App as AntApp,
  Button,
  Dropdown,
  Popover,
  Select,
  Space,
  Tag,
  Tooltip,
} from "antd";
import {
  Copy,
  Keyboard,
  Map as MapIcon,
  Maximize2,
  Network,
  Play,
  Plus,
  Redo2,
  Save,
  ScrollText,
  Square,
  SquareTerminal,
  Undo2,
  Zap,
} from "lucide-react";
import { useStore } from "../store";
import { api } from "../api";
import { activeGraphRef } from "../graph/active";

const SHORTCUTS: [string, string][] = [
  ["Ctrl/⌘ Z", "Undo"],
  ["Ctrl/⌘ ⇧ Z  ·  Ctrl/⌘ Y", "Redo"],
  ["Ctrl/⌘ C / X / V", "Copy / Cut / Paste"],
  ["Ctrl/⌘ D", "Duplicate selection"],
  ["Ctrl/⌘ A", "Select all"],
  ["Ctrl/⌘ S", "Save workflow"],
  ["F", "Zoom to fit"],
  ["L", "Auto-layout"],
  ["Delete", "Delete selection"],
];

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
  const histCanUndo = useStore((s) => s.histCanUndo);
  const histCanRedo = useStore((s) => s.histCanRedo);
  const minimapOn = useStore((s) => s.minimapOn);
  const toggleMinimap = useStore((s) => s.toggleMinimap);
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
      else if (r.status === "cancelled") message.warning("Run cancelled");
      else message.error(`Run ${r.status}${r.error ? ": " + r.error : ""}`);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onStop() {
    if (!activeFlowId) return;
    try {
      const r = await api.cancelFlowRuns(activeFlowId);
      message.info(r.cancelled ? "Stopping run…" : "No run in progress");
    } catch (e) {
      message.error((e as Error).message);
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
    items: [
      { key: "__note__", label: "📝 Note (annotation)" },
      { type: "divider" as const },
      ...Object.entries(
        nodes.reduce<Record<string, typeof nodes>>((acc, n) => {
          (acc[n.category] ||= []).push(n);
          return acc;
        }, {}),
      ).map(([cat, list]) => ({
        key: cat,
        label: cat,
        children: list.map((n) => ({
          key: n.type,
          label: n.label + (n.is_trigger ? " ⚡" : n.is_split ? " ⑂" : ""),
        })),
      })),
    ],
    onClick: ({ key }: { key: string }) => {
      if (key === "__note__") activeGraphRef.current?.addNote();
      else addNode(key);
    },
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

      {(view === "workflow" || view === "nodes") && flow && (
        <Space.Compact size="small">
          <Tooltip title="Undo (Ctrl/⌘ Z)">
            <Button
              icon={<Undo2 size={15} />}
              disabled={!histCanUndo}
              onClick={() => activeGraphRef.current?.undo()}
            />
          </Tooltip>
          <Tooltip title="Redo (Ctrl/⌘ ⇧ Z)">
            <Button
              icon={<Redo2 size={15} />}
              disabled={!histCanRedo}
              onClick={() => activeGraphRef.current?.redo()}
            />
          </Tooltip>
          <Tooltip title="Auto-layout (L)">
            <Button
              icon={<Network size={15} />}
              onClick={() => activeGraphRef.current?.autoLayout()}
            />
          </Tooltip>
          <Tooltip title="Zoom to fit (F)">
            <Button
              icon={<Maximize2 size={15} />}
              onClick={() => activeGraphRef.current?.zoomToFit()}
            />
          </Tooltip>
          <Tooltip title={minimapOn ? "Hide minimap" : "Show minimap"}>
            <Button
              type={minimapOn ? "primary" : "default"}
              ghost={minimapOn}
              icon={<MapIcon size={15} />}
              onClick={toggleMinimap}
            />
          </Tooltip>
          <Popover
            trigger="click"
            placement="bottomRight"
            title="Keyboard shortcuts"
            content={
              <div style={{ display: "grid", gap: 4, minWidth: 220 }}>
                {SHORTCUTS.map(([keys, label]) => (
                  <div
                    key={label}
                    style={{ display: "flex", justifyContent: "space-between", gap: 16 }}
                  >
                    <span style={{ opacity: 0.7 }}>{label}</span>
                    <kbd style={{ fontFamily: "var(--nbt-mono, monospace)" }}>
                      {keys}
                    </kbd>
                  </div>
                ))}
                <div style={{ opacity: 0.5, marginTop: 6, fontSize: 12 }}>
                  Click the canvas first so it has keyboard focus.
                </div>
              </div>
            }
          >
            <Tooltip title="Shortcuts">
              <Button icon={<Keyboard size={15} />} />
            </Tooltip>
          </Popover>
        </Space.Compact>
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
      ) : busy ? (
        <Button
          danger
          type="primary"
          size="small"
          icon={<Square size={14} />}
          onClick={onStop}
        >
          Stop
        </Button>
      ) : (
        <Button
          type="primary"
          size="small"
          icon={<Play size={15} />}
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

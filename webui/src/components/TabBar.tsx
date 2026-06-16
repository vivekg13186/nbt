import { useRef, useState } from "react";
import { App as AntApp, Button, Dropdown, Input, Modal, Tooltip } from "antd";
import type { MenuProps } from "antd";
import { Download, Menu, Plus, Upload, X } from "lucide-react";
import { useStore } from "../store";
import { api } from "../api";
import { activeGraphRef } from "../graph/active";
import type { Graph } from "../types";

export default function TabBar() {
  const { message, modal } = AntApp.useApp();
  const flows = useStore((s) => s.flows);
  const openTabs = useStore((s) => s.openTabs);
  const activeFlowId = useStore((s) => s.activeFlowId);
  const setActiveFlow = useStore((s) => s.setActiveFlow);
  const openFlow = useStore((s) => s.openFlow);
  const closeTab = useStore((s) => s.closeTab);
  const refreshFlows = useStore((s) => s.refreshFlows);

  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const importRef = useRef<HTMLInputElement>(null);

  const nameOf = (id: string) =>
    flows.find((f) => f.id === id)?.name ?? "(deleted)";

  // Save the graph the canvas is CURRENTLY displaying (activeGraphRef.flowId),
  // never the store's activeFlowId — which may already point at a different
  // tab while this one is still loading.
  async function saveActiveGraph() {
    const g = activeGraphRef.current;
    const fid = activeGraphRef.flowId;
    if (g && fid) {
      await api.saveGraph(fid, g.exportGraph());
    }
  }

  // ----- export: download a workflow's graph as JSON -----
  async function exportFlow(id: string) {
    try {
      const name = nameOf(id);
      const graph =
        id === activeGraphRef.flowId && activeGraphRef.current
          ? activeGraphRef.current.exportGraph()
          : (await api.getFlow(id)).graph;
      const blob = new Blob([JSON.stringify(graph, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${name}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  // ----- import: read a .json file as a new workflow -----
  async function importFromFile(file: File) {
    if (!/\.json$/i.test(file.name)) {
      message.error(`"${file.name}" is not a .json file`);
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch (e) {
      message.error(`Invalid JSON: ${(e as Error).message}`);
      return;
    }
    const obj = data as { nodes?: unknown; links?: unknown };
    if (!obj || typeof obj !== "object" || !Array.isArray(obj.nodes)) {
      message.error('Not a workflow graph (expected an object with "nodes")');
      return;
    }
    const graph: Graph = {
      nodes: obj.nodes as Graph["nodes"],
      links: Array.isArray(obj.links) ? (obj.links as Graph["links"]) : [],
    };
    const base = file.name.replace(/\.json$/i, "") || "Imported flow";
    for (let i = 0; ; i++) {
      const name = i === 0 ? base : `${base} (${i})`;
      try {
        const flow = await api.createFlow(name, graph);
        await refreshFlows();
        openFlow(flow.id);
        message.success(`Imported "${name}"`);
        return;
      } catch (e) {
        const msg = (e as Error).message;
        if (/exist|already|use/i.test(msg) && i < 20) continue;
        message.error(`Import failed: ${msg}`);
        return;
      }
    }
  }

  async function createFlow() {
    const name = newName.trim();
    if (!name) return;
    try {
      const flow = await api.createFlow(name, { nodes: [], links: [] });
      await refreshFlows();
      openFlow(flow.id);
      setNewOpen(false);
      setNewName("");
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  function tabMenu(id: string): MenuProps {
    return {
      items: [
        { key: "save", label: "Save" },
        { key: "rename", label: "Rename" },
        { key: "duplicate", label: "Duplicate" },
        { key: "export", label: "Export JSON" },
        { type: "divider" },
        { key: "close", label: "Close tab" },
        { key: "delete", label: "Delete workflow", danger: true },
      ],
      onClick: async ({ key, domEvent }) => {
        domEvent.stopPropagation();
        const name = nameOf(id);
        if (key === "save") {
          try {
            if (id === activeGraphRef.flowId) await saveActiveGraph();
            message.success(`Saved "${name}"`);
          } catch (e) {
            message.error((e as Error).message);
          }
        } else if (key === "rename") {
          renameFlow(id, name);
        } else if (key === "duplicate") {
          duplicateFlow(id, name);
        } else if (key === "export") {
          exportFlow(id);
        } else if (key === "close") {
          closeTab(id);
        } else if (key === "delete") {
          modal.confirm({
            title: `Delete "${name}"?`,
            content: "This permanently removes the workflow and stops its listener.",
            okType: "danger",
            okText: "Delete",
            onOk: async () => {
              await api.deleteFlow(id);
              closeTab(id);
              await refreshFlows();
            },
          });
        }
      },
    };
  }

  function renameFlow(id: string, current: string) {
    let value = current;
    modal.confirm({
      title: "Rename workflow",
      content: (
        <Input
          defaultValue={current}
          onChange={(e) => (value = e.target.value)}
          autoFocus
        />
      ),
      onOk: async () => {
        await api.renameFlow(id, value.trim());
        await refreshFlows();
      },
    });
  }

  function duplicateFlow(id: string, current: string) {
    let value = `${current} copy`;
    modal.confirm({
      title: "Duplicate workflow",
      content: (
        <Input
          defaultValue={value}
          onChange={(e) => (value = e.target.value)}
          autoFocus
        />
      ),
      onOk: async () => {
        const flow = await api.duplicateFlow(id, value.trim());
        await refreshFlows();
        openFlow(flow.id);
      },
    });
  }

  async function switchTo(id: string) {
    if (id === activeFlowId) return;
    try {
      await saveActiveGraph();
    } catch {
      /* non-fatal: still switch */
    }
    setActiveFlow(id);
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "4px 8px",
        borderBottom: "1px solid var(--nbt-border)",
        overflowX: "auto",
      }}
    >
      <strong style={{ marginRight: 8, whiteSpace: "nowrap" }}>NBT</strong>
      {openTabs.map((id) => {
        const active = id === activeFlowId;
        return (
          <Dropdown
            key={id}
            trigger={["contextMenu"]}
            menu={tabMenu(id)}
          >
            <div
              onClick={() => switchTo(id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 10px",
                borderRadius: 6,
                cursor: "pointer",
                whiteSpace: "nowrap",
                background: active ? "var(--nbt-active)" : "transparent",
                color: active ? "var(--nbt-primary)" : "inherit",
                border: "1px solid var(--nbt-border)",
              }}
            >
              <Dropdown menu={tabMenu(id)} trigger={["click"]}>
                <span
                  onClick={(e) => e.stopPropagation()}
                  style={{ opacity: 0.6, display: "flex" }}
                >
                  <Menu size={13} />
                </span>
              </Dropdown>
              <span>{nameOf(id)}</span>
              <span
                style={{ opacity: 0.6, display: "flex" }}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(id);
                }}
              >
                <X size={13} />
              </span>
            </div>
          </Dropdown>
        );
      })}
      <Tooltip title="New workflow">
        <Button
          type="text"
          size="small"
          icon={<Plus size={16} />}
          onClick={() => setNewOpen(true)}
        />
      </Tooltip>
      <Tooltip title="Import workflow (.json)">
        <Button
          type="text"
          size="small"
          icon={<Upload size={15} />}
          onClick={() => importRef.current?.click()}
        />
      </Tooltip>
      <Tooltip title="Export current workflow (.json)">
        <Button
          type="text"
          size="small"
          icon={<Download size={15} />}
          disabled={!activeFlowId}
          onClick={() => activeFlowId && exportFlow(activeFlowId)}
        />
      </Tooltip>
      <input
        ref={importRef}
        type="file"
        accept=".json"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) importFromFile(f);
          e.target.value = "";
        }}
      />
      <div style={{ flex: 1 }} />

      <Modal
        title="New workflow"
        open={newOpen}
        onOk={createFlow}
        onCancel={() => setNewOpen(false)}
        okText="Create"
      >
        <Input
          placeholder="Workflow name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onPressEnter={createFlow}
          autoFocus
        />
      </Modal>
    </div>
  );
}

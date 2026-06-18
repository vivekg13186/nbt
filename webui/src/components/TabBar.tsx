import { useMemo, useRef, useState } from "react";
import {
  App as AntApp,
  AutoComplete,
  Button,
  Dropdown,
  Input,
  Modal,
  Tooltip,
} from "antd";
import type { MenuProps } from "antd";
import { Download, Menu, Plus, Upload, X } from "lucide-react";
import { useStore } from "../store";
import { api } from "../api";
import { activeGraphRef } from "../graph/active";
import VersionsDrawer from "./VersionsDrawer";

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
  const [newFolder, setNewFolder] = useState("");
  const [versionsFor, setVersionsFor] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const folders = useMemo(
    () =>
      [...new Set(flows.map((f) => (f.folder || "").trim()).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b)),
    [flows],
  );

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

  // ----- export: download a workflow as a JSON or YAML file -----
  async function exportFlow(id: string, format: "json" | "yaml" = "json") {
    try {
      // save first so the file matches what's currently on the canvas
      if (id === activeGraphRef.flowId) await saveActiveGraph();
      const a = document.createElement("a");
      a.href = api.exportFlowFileUrl(id, format);
      a.click();
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  // ----- import: a .json/.yaml workflow file becomes a new workflow.
  // The backend reads the name + folder from the file (falling back to the
  // file name) and de-duplicates the name. -----
  async function importFromFile(file: File) {
    if (!/\.(json|ya?ml)$/i.test(file.name)) {
      message.error(`"${file.name}" is not a .json or .yaml file`);
      return;
    }
    try {
      const flow = await api.importFlow(file);
      await refreshFlows();
      openFlow(flow.id);
      message.success(`Imported "${flow.name}"`);
    } catch (e) {
      message.error(`Import failed: ${(e as Error).message}`);
    }
  }

  async function createFlow() {
    const name = newName.trim();
    if (!name) return;
    try {
      const flow = await api.createFlow(
        name, { nodes: [], links: [] }, newFolder.trim() || null);
      await refreshFlows();
      openFlow(flow.id);
      setNewOpen(false);
      setNewName("");
      setNewFolder("");
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  // Snapshot a workflow: save the live canvas first (if it's the one shown),
  // then create a read-only version, optionally labelled.
  function snapshotFlow(id: string, name: string) {
    let label = "";
    modal.confirm({
      title: `Snapshot "${name}"`,
      content: (
        <Input
          placeholder="Label (optional)"
          onChange={(e) => (label = e.target.value)}
          autoFocus
        />
      ),
      okText: "Snapshot",
      onOk: async () => {
        try {
          // snapshot the exact graph on the canvas (if this flow is shown),
          // so the snapshot is never the stale/empty saved copy
          const liveGraph =
            id === activeGraphRef.flowId && activeGraphRef.current
              ? activeGraphRef.current.exportGraph()
              : undefined;
          const v = await api.snapshotVersion(
            id, label.trim() || null, liveGraph);
          await refreshFlows();
          message.success(`Saved snapshot v${v.version}`);
        } catch (e) {
          message.error((e as Error).message);
        }
      },
    });
  }

  function tabMenu(id: string): MenuProps {
    return {
      items: [
        { key: "save", label: "Save" },
        { key: "rename", label: "Rename" },
        { key: "duplicate", label: "Duplicate" },
        {
          key: "export",
          label: "Export",
          children: [
            { key: "export:json", label: "JSON (.json)" },
            { key: "export:yaml", label: "YAML (.yaml)" },
          ],
        },
        { type: "divider" },
        { key: "snapshot", label: "Snapshot version" },
        { key: "versions", label: "Version history…" },
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
        } else if (key === "export:json") {
          exportFlow(id, "json");
        } else if (key === "export:yaml") {
          exportFlow(id, "yaml");
        } else if (key === "snapshot") {
          snapshotFlow(id, name);
        } else if (key === "versions") {
          setVersionsFor(id);
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
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginRight: 8,
          whiteSpace: "nowrap",
        }}
      >
        <img
          src="/sidebar.svg"
          alt="NBT"
          style={{ width: 20, height: 20, borderRadius: 5, display: "block" }}
        />
        <strong>NBT</strong>
      </span>
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
                borderRadius: 0,
                cursor: "pointer",
                whiteSpace: "nowrap",
                background: active ? "var(--nbt-active)" : "transparent",
                color: active ? "var(--nbt-primary)" : "inherit",
           marginBottom: -4,
           marginTop: -5,
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
      <Tooltip title="Import workflow (.json / .yaml)">
        <Button
          type="text"
          size="small"
          icon={<Upload size={15} />}
          onClick={() => importRef.current?.click()}
        />
      </Tooltip>
      <Dropdown
        trigger={["click"]}
        disabled={!activeFlowId}
        menu={{
          items: [
            { key: "json", label: "JSON (.json)" },
            { key: "yaml", label: "YAML (.yaml)" },
          ],
          onClick: ({ key }) =>
            activeFlowId && exportFlow(activeFlowId, key as "json" | "yaml"),
        }}
      >
        <Button
          type="text"
          size="small"
          icon={<Download size={15} />}
          disabled={!activeFlowId}
          title="Export current workflow (.json / .yaml)"
        />
      </Dropdown>
      <input
        ref={importRef}
        type="file"
        accept=".json,.yaml,.yml"
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
          style={{ marginBottom: 8 }}
        />
        <AutoComplete
          placeholder="Folder (optional)"
          options={folders.map((f) => ({ value: f }))}
          filterOption
          value={newFolder}
          onChange={setNewFolder}
          style={{ width: "100%" }}
        />
      </Modal>

      <VersionsDrawer
        flowId={versionsFor}
        flowName={versionsFor ? nameOf(versionsFor) : ""}
        open={!!versionsFor}
        onClose={() => setVersionsFor(null)}
      />
    </div>
  );
}

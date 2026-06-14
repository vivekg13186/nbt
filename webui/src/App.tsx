import { useEffect, useState } from "react";
import { App as AntApp } from "antd";
import { FileJson } from "lucide-react";
import { useStore } from "./store";
import { api } from "./api";
import type { Graph } from "./types";
import TabBar from "./components/TabBar";
import Toolbar from "./components/Toolbar";
import IconRail from "./components/IconRail";
import Sidebar from "./components/Sidebar";
import GraphEditor from "./components/GraphEditor";
import EnvEditor from "./components/EnvEditor";
import ListenersPage from "./components/ListenersPage";
import RunsPage from "./components/RunsPage";
import PackagesPage from "./components/PackagesPage";
import Terminal from "./components/Terminal";

export default function App() {
  const { message } = AntApp.useApp();
  const view = useStore((s) => s.view);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const terminalOpen = useStore((s) => s.terminalOpen);
  const loadNodes = useStore((s) => s.loadNodes);
  const refreshFlows = useStore((s) => s.refreshFlows);
  const refreshEnvs = useStore((s) => s.refreshEnvs);
  const openFlow = useStore((s) => s.openFlow);
  const setView = useStore((s) => s.setView);

  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    Promise.all([loadNodes(), refreshFlows(), refreshEnvs()]).catch((e) =>
      message.error("Cannot reach NBT API: " + e.message),
    );
  }, [loadNodes, refreshFlows, refreshEnvs, message]);

  // Install a dropped node-package bundle (.nbtpack / .zip).
  async function importPackage(file: File) {
    try {
      const r = await api.installZip(file);
      loadNodes();
      setView("packages");
      message.success(`Installed package "${r.package.name}"`);
    } catch (e) {
      message.error(`Package install failed: ${(e as Error).message}`);
    }
  }

  // Import a dropped workflow JSON file as a new workflow tab, or show why
  // it couldn't be imported.
  async function importFile(file: File) {
    if (/\.(nbtpack|zip)$/i.test(file.name)) {
      importPackage(file);
      return;
    }
    if (!/\.json$/i.test(file.name)) {
      message.error(`"${file.name}" is not a .json or .nbtpack/.zip file`);
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch (e) {
      message.error(`Invalid JSON in "${file.name}": ${(e as Error).message}`);
      return;
    }
    const obj = data as { nodes?: unknown; links?: unknown };
    if (!obj || typeof obj !== "object" || !Array.isArray(obj.nodes)) {
      message.error(
        `"${file.name}" is not a workflow graph (expected an object with a "nodes" array)`,
      );
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
        if (/exist|already|use/i.test(msg) && i < 20) continue; // name clash
        message.error(`Import failed: ${msg}`);
        return;
      }
    }
  }

  function onDrop(e: React.DragEvent) {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) importFile(file);
  }

  return (
    <div
      className="nbt-shell nbt-dark"
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setDragging(false);
        }
      }}
      onDrop={onDrop}
    >
      <TabBar />
      <Toolbar />
      <div className="nbt-body">
        <IconRail />
        {sidebarOpen && <Sidebar />}
        <div className="nbt-main">
          {/* GraphEditor stays mounted (keeps the canvas) but hides when
              another view is active, so switching tabs is instant. */}
          <div
            style={{
              display:
                view === "workflow" || view === "nodes" ? "flex" : "none",
              flex: 1,
              flexDirection: "column",
              minHeight: 0,
            }}
          >
            <GraphEditor />
          </div>
          {view === "environment" && <EnvEditor />}
          {view === "listeners" && <ListenersPage />}
          {view === "runs" && <RunsPage />}
          {view === "packages" && <PackagesPage />}
          {terminalOpen && <Terminal />}
        </div>
      </div>

      {dragging && (
        <div className="nbt-dropzone">
          <div className="nbt-dropzone-card">
            <FileJson size={40} />
            <div style={{ marginTop: 10, fontSize: 16 }}>
              Drop a workflow <code>.json</code> or a node package{" "}
              <code>.nbtpack</code> to install it
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

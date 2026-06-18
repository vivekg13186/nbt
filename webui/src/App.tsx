import { lazy, Suspense, useEffect, useState } from "react";
import { App as AntApp } from "antd";
import { FileJson } from "lucide-react";
import { useStore } from "./store";
import { api } from "./api";
import TabBar from "./components/TabBar";
import Toolbar from "./components/Toolbar";
import IconRail from "./components/IconRail";
import Sidebar from "./components/Sidebar";
import GraphEditor from "./components/GraphEditor";

// Lazy-loaded on demand so their heavy deps (CodeMirror, xterm) stay out of
// the initial bundle until the relevant view/panel is opened.
const EnvEditor = lazy(() => import("./components/EnvEditor"));
const ListenersPage = lazy(() => import("./components/ListenersPage"));
const SchedulesPage = lazy(() => import("./components/SchedulesPage"));
const RunsPage = lazy(() => import("./components/RunsPage"));
const PackagesPage = lazy(() => import("./components/PackagesPage"));
const Terminal = lazy(() => import("./components/Terminal"));

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

  // Import a dropped workflow file (.json/.yaml) as a new workflow tab, or a
  // dropped package bundle (.nbtpack/.zip), or show why it couldn't be used.
  async function importFile(file: File) {
    if (/\.(nbtpack|zip)$/i.test(file.name)) {
      importPackage(file);
      return;
    }
    if (!/\.(json|ya?ml)$/i.test(file.name)) {
      message.error(
        `"${file.name}" is not a .json/.yaml workflow or .nbtpack/.zip package`,
      );
      return;
    }
    try {
      // the backend reads name + folder from the file and de-dups the name
      const flow = await api.importFlow(file);
      await refreshFlows();
      openFlow(flow.id);
      message.success(`Imported "${flow.name}"`);
    } catch (e) {
      message.error(`Import failed: ${(e as Error).message}`);
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
          <Suspense fallback={<div className="nbt-empty">Loading…</div>}>
            {view === "environment" && <EnvEditor />}
            {view === "listeners" && <ListenersPage />}
            {view === "schedules" && <SchedulesPage />}
            {view === "runs" && <RunsPage />}
            {view === "packages" && <PackagesPage />}
            {terminalOpen && <Terminal />}
          </Suspense>
        </div>
      </div>

      {dragging && (
        <div className="nbt-dropzone">
          <div className="nbt-dropzone-card">
            <FileJson size={40} />
            <div style={{ marginTop: 10, fontSize: 16 }}>
              Drop a workflow <code>.json</code> / <code>.yaml</code> or a node
              package <code>.nbtpack</code> to install it
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

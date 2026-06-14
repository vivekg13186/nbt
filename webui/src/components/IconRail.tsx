import { Tooltip } from "antd";
import {
  ChevronLeft,
  ChevronRight,
  History,
  LayoutGrid,
  Settings,
  Workflow,
  Zap,
} from "lucide-react";
import { useStore } from "../store";
import type { View } from "../store";

const ITEMS: { view: View; icon: React.ReactNode; label: string }[] = [
  { view: "workflow", icon: <Workflow size={20} />, label: "Workflows" },
  { view: "nodes", icon: <LayoutGrid size={20} />, label: "Nodes" },
  { view: "environment", icon: <Settings size={20} />, label: "Environments" },
  { view: "listeners", icon: <Zap size={20} />, label: "Listeners" },
  { view: "runs", icon: <History size={20} />, label: "Executions" },
];

const SIDEBAR_VIEWS: View[] = ["workflow", "nodes", "environment"];

export default function IconRail() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);

  return (
    <div className="nbt-rail">
      {ITEMS.map((it) => (
        <Tooltip title={it.label} placement="right" key={it.view}>
          <div
            className={"nbt-rail-btn" + (view === it.view ? " active" : "")}
            onClick={() => {
              if (view === it.view && SIDEBAR_VIEWS.includes(it.view)) {
                toggleSidebar();
              } else {
                setView(it.view);
              }
            }}
          >
            {it.icon}
          </div>
        </Tooltip>
      ))}
      <div style={{ flex: 1 }} />
      {SIDEBAR_VIEWS.includes(view) && (
        <Tooltip title={sidebarOpen ? "Hide sidebar" : "Show sidebar"} placement="right">
          <div className="nbt-rail-btn" onClick={toggleSidebar}>
            {sidebarOpen ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
          </div>
        </Tooltip>
      )}
    </div>
  );
}

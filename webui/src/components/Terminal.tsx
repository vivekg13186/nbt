import { useState } from "react";
import { Badge, Button, Tooltip } from "antd";
import { ChevronDown, Eraser, RotateCw } from "lucide-react";
import { useStore } from "../store";
import ShellBody from "./ShellBody";
import LogBody from "./LogBody";

export default function Terminal() {
  const toggleTerminal = useStore((s) => s.toggleTerminal);
  const tab = useStore((s) => s.bottomTab);
  const setTab = useStore((s) => s.setBottomTab);

  const [shellGen, setShellGen] = useState(0);
  const [logClear, setLogClear] = useState(0);
  const [shellConn, setShellConn] = useState(false);
  const [logConn, setLogConn] = useState(false);

  const conn = tab === "shell" ? shellConn : logConn;

  function tabBtn(key: "shell" | "log", label: string) {
    const activeTab = tab === key;
    return (
      <span
        onClick={() => setTab(key)}
        style={{
          cursor: "pointer",
          padding: "2px 10px",
          borderRadius: 6,
          fontWeight: activeTab ? 600 : 400,
          background: activeTab ? "var(--nbt-active)" : "transparent",
          color: activeTab ? "var(--nbt-primary)" : "inherit",
        }}
      >
        {label}
      </span>
    );
  }

  return (
    <div className="nbt-terminal">
      <div className="nbt-terminal-head">
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Badge status={conn ? "success" : "error"} />
          {tabBtn("shell", "Shell")}
          {tabBtn("log", "Log")}
        </span>
        <span>
          {tab === "shell" ? (
            <Tooltip title="Restart shell">
              <Button
                type="text"
                size="small"
                icon={<RotateCw size={15} />}
                onClick={() => setShellGen((g) => g + 1)}
              />
            </Tooltip>
          ) : (
            <Tooltip title="Clear log">
              <Button
                type="text"
                size="small"
                icon={<Eraser size={15} />}
                onClick={() => setLogClear((c) => c + 1)}
              />
            </Tooltip>
          )}
          <Tooltip title="Hide panel">
            <Button
              type="text"
              size="small"
              icon={<ChevronDown size={15} />}
              onClick={toggleTerminal}
            />
          </Tooltip>
        </span>
      </div>
      {/* both bodies stay mounted so the shell session and log stream
          persist while switching tabs */}
      <ShellBody
        generation={shellGen}
        active={tab === "shell"}
        onConn={setShellConn}
      />
      <LogBody
        active={tab === "log"}
        clearSignal={logClear}
        onConn={setLogConn}
      />
    </div>
  );
}

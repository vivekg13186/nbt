import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

function shellSocketUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/shell`;
}

// Dark terminal palette.
const TERM_THEME = {
  background: "#0c0c0c",
  foreground: "#cccccc",
  cursor: "#eeedf0",
  cursorAccent: "#0c0c0c",
  selectionBackground: "#264f78",
  black: "#0c0c0c",
  red: "#c50f1f",
  green: "#13a10e",
  yellow: "#c19c00",
  blue: "#3b78ff",
  magenta: "#881798",
  cyan: "#3a96dd",
  white: "#cccccc",
  brightBlack: "#767676",
  brightRed: "#e74856",
  brightGreen: "#16c60c",
  brightYellow: "#f9f1a5",
  brightBlue: "#5ca0f2",
  brightMagenta: "#b4009e",
  brightCyan: "#61d6d6",
  brightWhite: "#f2f2f2",
};

export default function ShellBody({
  generation,
  active,
  onConn,
}: {
  generation: number;
  active: boolean;
  onConn: (b: boolean) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const term = new XTerm({
      fontFamily:
        '"Cascadia Mono", "Consolas", "SF Mono", ui-monospace, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: TERM_THEME,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    fitRef.current = fit;

    const enc = new TextEncoder();
    let ws: WebSocket;
    let stopped = false;

    function sendResize() {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ resize: [term.cols, term.rows] }));
      }
    }
    function connect() {
      ws = new WebSocket(shellSocketUrl());
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        onConn(true);
        sendResize();
        term.focus();
      };
      ws.onclose = () => {
        onConn(false);
        if (!stopped) term.write("\r\n\x1b[90m[shell exited]\x1b[0m\r\n");
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") term.write(ev.data);
        else term.write(new Uint8Array(ev.data));
      };
    }
    connect();

    const dataSub = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(enc.encode(d));
    });
    const resizeSub = term.onResize(() => sendResize());
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    });
    ro.observe(hostRef.current);

    return () => {
      stopped = true;
      ro.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      term.dispose();
    };
  }, [generation]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fit when the tab becomes visible (it has zero size while hidden).
  useEffect(() => {
    if (active) {
      const id = setTimeout(() => {
        try {
          fitRef.current?.fit();
        } catch {
          /* ignore */
        }
      }, 30);
      return () => clearTimeout(id);
    }
  }, [active]);

  return (
    <div
      className="nbt-terminal-body"
      style={{ display: active ? "block" : "none" }}
    >
      <div ref={hostRef} className="nbt-xterm-host" />
    </div>
  );
}

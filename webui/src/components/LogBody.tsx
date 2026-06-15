import { useEffect, useRef, useState } from "react";
import { logSocketUrl } from "../api";
import type { LogLine } from "../types";

export default function LogBody({
  active,
  clearSignal,
  onConn,
}: {
  active: boolean;
  clearSignal: number;
  onConn: (b: boolean) => void;
}) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stopped = false;
    let retry: ReturnType<typeof setTimeout>;
    let ws: WebSocket;
    function connect() {
      ws = new WebSocket(logSocketUrl());
      ws.onopen = () => onConn(true);
      ws.onclose = () => {
        onConn(false);
        if (!stopped) retry = setTimeout(connect, 1500);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (ev) => {
        try {
          const line = JSON.parse(ev.data) as LogLine;
          setLines((prev) => [...prev.slice(-800), line]);
        } catch {
          /* ignore */
        }
      };
    }
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (clearSignal > 0) setLines([]);
  }, [clearSignal]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el && active) el.scrollTop = el.scrollHeight;
  }, [lines, active]);

  return (
    <div
      className="nbt-log-body"
      ref={bodyRef}
      style={{ display: active ? "block" : "none" }}
    >
      {lines.length === 0 && (
        <span style={{ opacity: 0.4 }}>
          Waiting for run / listener / package output…
        </span>
      )}
      {lines.map((l, i) => (
        <div key={i} className={"nbt-log-" + l.level}>
          <span className="nbt-log-ts">
            {new Date(l.ts * 1000).toLocaleTimeString()}
          </span>
          {l.text}
        </div>
      ))}
    </div>
  );
}

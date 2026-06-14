import type {
  Environment,
  Execution,
  ExecutionDetail,
  Flow,
  FlowSummary,
  Graph,
  ListenerStat,
  LoadError,
  NodeMeta,
  RunResult,
} from "./types";

const BASE = "/api";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (body?.detail) detail = body.detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  // meta
  nodes: () =>
    req<{ nodes: NodeMeta[]; load_errors: LoadError[] }>("/nodes"),

  // flows
  listFlows: () => req<FlowSummary[]>("/flows"),
  getFlow: (id: string) => req<Flow>(`/flows/${id}`),
  createFlow: (name: string, graph?: Graph) =>
    req<Flow>("/flows", {
      method: "POST",
      body: JSON.stringify({ name, graph }),
    }),
  renameFlow: (id: string, name: string) =>
    req<Flow>(`/flows/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  saveGraph: (id: string, graph: Graph) =>
    req<Flow>(`/flows/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ graph }),
    }),
  duplicateFlow: (id: string, name: string) =>
    req<Flow>(`/flows/${id}/duplicate`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  deleteFlow: (id: string) =>
    req<{ ok: boolean }>(`/flows/${id}`, { method: "DELETE" }),
  runFlow: (id: string, environment?: string | null) =>
    req<RunResult>(`/flows/${id}/run`, {
      method: "POST",
      body: JSON.stringify({ environment }),
    }),

  // environments
  listEnvs: () => req<Environment[]>("/environments"),
  createEnv: (name: string, vars: Record<string, unknown>) =>
    req<Environment>("/environments", {
      method: "POST",
      body: JSON.stringify({ name, vars }),
    }),
  updateEnv: (
    id: string,
    body: { name?: string; vars?: Record<string, unknown> },
  ) =>
    req<Environment>(`/environments/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteEnv: (id: string) =>
    req<{ ok: boolean }>(`/environments/${id}`, { method: "DELETE" }),

  // executions
  listExecutions: (limit = 200) =>
    req<Execution[]>(`/executions?limit=${limit}`),
  getExecution: (id: string) => req<ExecutionDetail>(`/executions/${id}`),
  clearExecutions: () =>
    req<{ ok: boolean }>("/executions", { method: "DELETE" }),

  // listeners
  listeners: () => req<ListenerStat[]>("/listeners"),
  startListen: (id: string, environment?: string | null) =>
    req<{ ok: boolean; listeners: ListenerStat[] }>(`/flows/${id}/listen`, {
      method: "POST",
      body: JSON.stringify({ environment }),
    }),
  stopListen: (id: string) =>
    req<{ ok: boolean }>(`/listeners/${id}`, { method: "DELETE" }),
  stopAllListen: () =>
    req<{ ok: boolean; stopped: number }>("/listeners", { method: "DELETE" }),
};

export function logSocketUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/logs`;
}

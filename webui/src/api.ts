import type {
  Environment,
  Execution,
  ExecutionDetail,
  Flow,
  FlowSummary,
  Graph,
  FlowVersion,
  FlowVersionDetail,
  ListenerStat,
  LoadError,
  NodeMeta,
  NodePackage,
  PackagesResult,
  RunResult,
  Schedule,
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
  // URL of the export zip (all flows, or one folder). folder "" = ungrouped.
  exportFlowsUrl: (folder?: string | null, format: "json" | "yaml" = "json") => {
    const params = new URLSearchParams();
    if (folder !== undefined && folder !== null) params.set("folder", folder);
    if (format !== "json") params.set("format", format);
    const qs = params.toString();
    return BASE + "/flows/export" + (qs ? `?${qs}` : "");
  },
  // URL to download one flow as a json/yaml workflow file
  exportFlowFileUrl: (id: string, format: "json" | "yaml" = "json") =>
    `${BASE}/flows/${id}/export?format=${format}`,
  // import a workflow file (.json/.yaml/.yml); folder optionally overrides the
  // file's own folder. Returns the created flow.
  importFlow: async (file: File, folder?: string | null) => {
    const form = new FormData();
    form.append("file", file);
    if (folder) form.append("folder", folder);
    const res = await fetch(BASE + "/flows/import", {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const b = await res.json();
        if (b?.detail) detail = b.detail;
      } catch {
        /* ignore */
      }
      throw new Error(detail);
    }
    return (await res.json()) as Flow;
  },
  getFlow: (id: string) => req<Flow>(`/flows/${id}`),
  createFlow: (name: string, graph?: Graph, folder?: string | null) =>
    req<Flow>("/flows", {
      method: "POST",
      body: JSON.stringify({ name, graph, folder: folder || null }),
    }),
  renameFlow: (id: string, name: string) =>
    req<Flow>(`/flows/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  setFlowFolder: (id: string, folder: string | null) =>
    req<Flow>(`/flows/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ set_folder: true, folder: folder || null }),
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
  // cancel any in-flight Run(s) of a flow (the toolbar Stop button)
  cancelFlowRuns: (id: string) =>
    req<{ ok: boolean; cancelled: number }>(`/flows/${id}/cancel`, {
      method: "POST",
    }),
  // cancel one running execution by id (Executions page)
  cancelExecution: (execId: string) =>
    req<{ ok: boolean }>(`/executions/${execId}/cancel`, { method: "POST" }),

  // versions (snapshots)
  snapshotVersion: (flowId: string, label?: string | null, graph?: Graph) =>
    req<FlowVersion>(`/flows/${flowId}/versions`, {
      method: "POST",
      body: JSON.stringify({ label: label || null, graph: graph ?? null }),
    }),
  listVersions: (flowId: string) =>
    req<FlowVersion[]>(`/flows/${flowId}/versions`),
  getVersion: (versionId: string) =>
    req<FlowVersionDetail>(`/versions/${versionId}`),
  runVersion: (versionId: string, environment?: string | null) =>
    req<RunResult>(`/versions/${versionId}/run`, {
      method: "POST",
      body: JSON.stringify({ environment }),
    }),
  deleteVersion: (versionId: string) =>
    req<{ ok: boolean }>(`/versions/${versionId}`, { method: "DELETE" }),

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

  // node packages
  listPackages: () => req<PackagesResult>("/packages"),
  installGit: (url: string, ref?: string | null) =>
    req<PackagesResult & { package: NodePackage; pip_log?: string }>(
      "/packages/install_git",
      { method: "POST", body: JSON.stringify({ url, ref: ref || null }) },
    ),
  installZip: async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(BASE + "/packages/install_zip", {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const b = await res.json();
        if (b?.detail) detail = b.detail;
      } catch {
        /* ignore */
      }
      throw new Error(detail);
    }
    return (await res.json()) as PackagesResult & {
      package: NodePackage;
      pip_log?: string;
    };
  },
  updatePackage: (name: string) =>
    req<PackagesResult>(`/packages/${encodeURIComponent(name)}/update`, {
      method: "POST",
    }),
  removePackage: (name: string) =>
    req<PackagesResult>(`/packages/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),

  // schedules (cron)
  listSchedules: () => req<Schedule[]>("/schedules"),
  createSchedule: (body: {
    flow_id: string;
    cron: string;
    environment?: string | null;
    enabled?: boolean;
  }) =>
    req<Schedule>("/schedules", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateSchedule: (
    id: string,
    body: {
      cron?: string;
      environment?: string | null;
      set_environment?: boolean;
      enabled?: boolean;
    },
  ) =>
    req<Schedule>(`/schedules/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteSchedule: (id: string) =>
    req<{ ok: boolean }>(`/schedules/${id}`, { method: "DELETE" }),
  runSchedule: (id: string) =>
    req<RunResult>(`/schedules/${id}/run`, { method: "POST" }),

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

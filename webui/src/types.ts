export interface NodeParam {
  name: string;
  default: unknown;
  kind: "text" | "int" | "float" | "bool";
}

export interface NodeMeta {
  type: string;
  label: string;
  category: string;
  params: NodeParam[];
  outputs: string[];
  is_trigger: boolean;
}

export interface LoadError {
  file: string;
  error: string;
}

export interface NodePackageSource {
  type: "git" | "zip" | "local";
  url?: string;
  ref?: string | null;
  filename?: string;
}

export interface NodePackage {
  name: string;
  version: string | null;
  description?: string | null;
  author?: string | null;
  requirements: string[];
  source: NodePackageSource;
  installed: boolean;
  node_count: number;
  installed_at?: number;
}

export interface PackagesResult {
  packages: NodePackage[];
  load_errors: LoadError[];
}

export interface GraphNode {
  id: string;
  type: string;
  name: string;
  params: Record<string, unknown>;
  pre: string;
  post: string;
  out_aliases: Record<string, string>;
  pos: [number, number];
  size?: [number, number];
}

export interface GraphGroup {
  title?: string;
  bounding?: number[];
  color?: string;
  font_size?: number;
}

export interface Graph {
  nodes: GraphNode[];
  links: [string, string][];
  groups?: GraphGroup[];
}

export interface FlowSummary {
  id: string;
  name: string;
  folder?: string | null;
  created_at: number;
  updated_at: number;
}

export interface Flow extends FlowSummary {
  graph: Graph;
  listening?: boolean;
}

export interface FlowVersion {
  id: string;
  flow_id: string;
  version: number;
  label: string | null;
  created_at: number;
}

export interface FlowVersionDetail extends FlowVersion {
  graph: Graph;
}

export interface Environment {
  id: string;
  name: string;
  vars: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

export interface Execution {
  id: string;
  flow_id: string | null;
  flow_name: string | null;
  environment: string | null;
  status: "running" | "passed" | "failed" | "error";
  error: string | null;
  started_at: number;
  finished_at: number | null;
}

export interface ExecutionStep {
  id: number;
  execution_id: string;
  node_id: string | null;
  node_name: string | null;
  node_type: string | null;
  status: "passed" | "failed" | "skipped";
  error: string | null;
  inputs: string | null;
  outputs: string | null;
  started_at: number | null;
  finished_at: number | null;
}

export interface ExecutionDetail extends Execution {
  steps: ExecutionStep[];
  context?: Record<string, unknown> | null;
}

export interface ListenerStat {
  flow_id: string;
  flow_name: string;
  environment: string | null;
  active: boolean;
  events: number;
  runs: number;
  filtered: number;
  skipped_busy: number;
  last_status: string | null;
  last_exec_id: string | null;
}

export interface RunResult {
  execution_id: string;
  status: string;
  error: string | null;
}

export interface LogLine {
  ts: number;
  level: "info" | "ok" | "error";
  text: string;
}

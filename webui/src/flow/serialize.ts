// Convert between the NBT graph JSON (what the engine reads / the API stores)
// and React Flow's { nodes, edges }. Nodes carry their config in `data`; the
// canvas only shows a title + one input/one output edge — params/pre/post/
// output-aliases are edited in the right-hand property panel.
import type { Node, Edge } from "@xyflow/react";
import type { Graph, GraphNode, NodeMeta } from "../types";

export interface NbtData {
  nbtType: string;
  name: string; // editable title; also the engine node name
  label: string; // node-type label (fallback title)
  params: Record<string, unknown>;
  pre: string;
  post: string;
  aliases: Record<string, string>; // output name -> published variable
  isTrigger: boolean;
  isSplit: boolean;
  color?: string; // optional custom accent colour
}

export function defaultsFor(meta: NodeMeta): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  meta.params.forEach((p) => (out[p.name] = p.default));
  return out;
}

function coerce(meta: NodeMeta, name: string, value: unknown): unknown {
  const p = meta.params.find((q) => q.name === name);
  if (!p) return value;
  if (p.kind === "int") return Math.round(Number(value) || 0);
  if (p.kind === "float") return Number(value) || 0;
  if (p.kind === "bool") return !!value;
  return value === undefined || value === null ? "" : String(value);
}

export function graphToFlow(
  graph: Graph,
  metas: NodeMeta[],
): { nodes: Node[]; edges: Edge[] } {
  const byType: Record<string, NodeMeta> = {};
  metas.forEach((m) => (byType[m.type] = m));

  const nodes: Node[] = (graph.nodes || [])
    .filter((n) => byType[n.type])
    .map((n, i) => {
      const m = byType[n.type];
      const legacy = n as unknown as { condition?: string; assert?: string };
      const data: NbtData = {
        nbtType: n.type,
        name: n.name || m.label,
        label: m.label,
        params: { ...defaultsFor(m), ...(n.params || {}) },
        pre: n.pre || legacy.condition || "",
        post: n.post || legacy.assert || "",
        aliases: { ...(n.out_aliases || {}) },
        isTrigger: !!m.is_trigger,
        isSplit: !!m.is_split,
        color: n.color,
      };
      return {
        id: n.id,
        type: "nbt",
        position: {
          x: n.pos?.[0] ?? 80 + (i % 5) * 240,
          y: n.pos?.[1] ?? 80 + Math.floor(i / 5) * 140,
        },
        data: data as unknown as Record<string, unknown>,
      };
    });

  const edges: Edge[] = (graph.links || []).map((l, i) => ({
    id: `e${i}-${l[0]}-${l[1]}`,
    source: l[0],
    target: l[1],
    sourceHandle: "out",
    targetHandle: "in",
  }));
  return { nodes, edges };
}

export function flowToGraph(
  nodes: Node[],
  edges: Edge[],
  metas: NodeMeta[],
): Graph {
  const byType: Record<string, NodeMeta> = {};
  metas.forEach((m) => (byType[m.type] = m));

  const gnodes: GraphNode[] = nodes.map((n) => {
    const d = n.data as unknown as NbtData;
    const m = byType[d.nbtType];
    const params: Record<string, unknown> = {};
    for (const k in d.params) {
      params[k] = m ? coerce(m, k, d.params[k]) : d.params[k];
    }
    const aliases: Record<string, string> = {};
    for (const k in d.aliases || {}) {
      const v = String(d.aliases[k] || "").trim();
      if (v) aliases[k] = v;
    }
    return {
      id: n.id,
      type: d.nbtType,
      name: (d.name || d.label || "").trim() || d.nbtType,
      params,
      pre: d.pre || "",
      post: d.post || "",
      out_aliases: aliases,
      pos: [Math.round(n.position.x), Math.round(n.position.y)],
      ...(d.color ? { color: d.color } : {}),
    };
  });

  const links: [string, string][] = edges
    .filter((e) => e.source && e.target)
    .map((e) => [e.source, e.target]);

  return { nodes: gnodes, links };
}

// Cross-flow clipboard for copy/paste. Lives at module scope (and is mirrored
// to localStorage) so a selection copied in one workflow can be pasted into
// another after switching tabs / windows.
import type { NbtData } from "./serialize";

export interface ClipNode {
  data: NbtData;
  x: number;
  y: number;
}
export interface Clip {
  nodes: ClipNode[];
  edges: [number, number][]; // indices into nodes[]
}

const KEY = "nbt.flow.clipboard";
let mem: Clip | null = null;

export function writeClip(c: Clip): void {
  mem = c;
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* storage unavailable: module var still works within this window */
  }
}

export function readClip(): Clip | null {
  if (mem) return mem;
  try {
    const s = localStorage.getItem(KEY);
    return s ? (JSON.parse(s) as Clip) : null;
  } catch {
    return null;
  }
}

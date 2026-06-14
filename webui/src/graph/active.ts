import type { NbtGraph } from "./nbtGraph";

// Non-reactive handle to the currently mounted graph controller so the
// toolbar (Run / Save) can read the live canvas without prop drilling.
export const activeGraphRef: { current: NbtGraph | null } = { current: null };

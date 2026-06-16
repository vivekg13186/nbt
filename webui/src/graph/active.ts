import type { NbtGraph } from "./nbtGraph";

// Non-reactive handle to the currently mounted graph controller so the
// toolbar / tab bar (Run / Save / Export) can read the live canvas without
// prop drilling.
//
// `flowId` is the id of the flow the canvas is CURRENTLY displaying. It is
// null while a flow is loading (or no flow is open). Saves must use this id,
// not the store's activeFlowId — otherwise a save during a tab switch can
// write the old canvas content into the newly-selected flow.
export const activeGraphRef: {
  current: NbtGraph | null;
  flowId: string | null;
} = { current: null, flowId: null };

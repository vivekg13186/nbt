import type { Graph } from "../types";

// Non-reactive handle to the currently mounted editor so the toolbar / tab bar
// (Run / Save / Export / Add node) can read the live canvas without prop
// drilling. The React Flow editor sets `current` to a small shim.
//
// `flowId` is the id of the flow the canvas is CURRENTLY displaying. It is
// null while a flow is loading (or no flow is open). Saves must use this id,
// not the store's activeFlowId — otherwise a save during a tab switch can
// write the old canvas content into the newly-selected flow.
export interface ActiveGraph {
  exportGraph: () => Graph;
  addNode: (type: string) => void;
  undo: () => void;
  redo: () => void;
  autoLayout: () => void;
  fitView: () => void;
}

export const activeGraphRef: {
  current: ActiveGraph | null;
  flowId: string | null;
} = { current: null, flowId: null };

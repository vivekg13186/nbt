import { create } from "zustand";
import { api } from "./api";
import type { Environment, FlowSummary, LoadError, NodeMeta } from "./types";

export type View =
  | "workflow"
  | "nodes"
  | "environment"
  | "listeners"
  | "runs";

const ENV_KEY = "nbt.activeEnv";

interface State {
  // node registry
  nodes: NodeMeta[];
  loadErrors: LoadError[];
  loadNodes: () => Promise<void>;

  // flows
  flows: FlowSummary[];
  refreshFlows: () => Promise<void>;

  // environments
  envs: Environment[];
  refreshEnvs: () => Promise<void>;
  activeEnvName: string | null;
  setActiveEnv: (name: string | null) => void;

  // navigation
  view: View;
  setView: (v: View) => void;
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  terminalOpen: boolean;
  toggleTerminal: () => void;
  setTerminalOpen: (b: boolean) => void;

  // open workflow tabs
  openTabs: string[]; // flow ids, in order
  activeFlowId: string | null;
  openFlow: (id: string) => void;
  closeTab: (id: string) => void;
  setActiveFlow: (id: string | null) => void;
}

export const useStore = create<State>((set, get) => ({
  nodes: [],
  loadErrors: [],
  loadNodes: async () => {
    const r = await api.nodes();
    set({ nodes: r.nodes, loadErrors: r.load_errors });
  },

  flows: [],
  refreshFlows: async () => {
    const flows = await api.listFlows();
    set({ flows });
  },

  envs: [],
  refreshEnvs: async () => {
    const envs = await api.listEnvs();
    set({ envs });
    // drop a stale active env selection
    const active = get().activeEnvName;
    if (active && !envs.some((e) => e.name === active)) {
      get().setActiveEnv(null);
    }
  },
  activeEnvName: localStorage.getItem(ENV_KEY) || null,
  setActiveEnv: (name) => {
    if (name) localStorage.setItem(ENV_KEY, name);
    else localStorage.removeItem(ENV_KEY);
    set({ activeEnvName: name });
  },

  view: "workflow",
  setView: (view) =>
    set({
      view,
      sidebarOpen:
        view === "workflow" || view === "environment" || view === "nodes",
    }),
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  terminalOpen: false,
  toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),
  setTerminalOpen: (terminalOpen) => set({ terminalOpen }),

  openTabs: [],
  activeFlowId: null,
  openFlow: (id) =>
    set((s) => ({
      openTabs: s.openTabs.includes(id) ? s.openTabs : [...s.openTabs, id],
      activeFlowId: id,
      view: "workflow",
    })),
  closeTab: (id) =>
    set((s) => {
      const openTabs = s.openTabs.filter((t) => t !== id);
      let activeFlowId = s.activeFlowId;
      if (activeFlowId === id) {
        const idx = s.openTabs.indexOf(id);
        activeFlowId = openTabs[idx] || openTabs[idx - 1] || openTabs[0] || null;
      }
      return { openTabs, activeFlowId };
    }),
  setActiveFlow: (activeFlowId) => set({ activeFlowId, view: "workflow" }),
}));

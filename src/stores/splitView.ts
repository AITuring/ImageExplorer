import { create } from "zustand";
import { persist } from "zustand/middleware";

export type SplitPaneId = "primary" | "secondary";

const MIN_SPLIT_RATIO = 0.25;
const MAX_SPLIT_RATIO = 0.75;

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, value));
}

interface SplitViewState {
  enabled: boolean;
  secondaryPath: string;
  secondaryHistory: string[];
  secondaryHistoryIndex: number;
  activePane: SplitPaneId;
  splitRatio: number;
  toggleSplitView: (initialPath: string) => void;
  openSplitView: (path: string) => void;
  closeSplitView: () => void;
  setActivePane: (pane: SplitPaneId) => void;
  navigateSecondary: (path: string) => void;
  goBackSecondary: () => void;
  goForwardSecondary: () => void;
  setSplitRatio: (ratio: number) => void;
}

export const useSplitView = create<SplitViewState>()(
  persist(
    (set) => ({
      enabled: false,
      secondaryPath: "",
      secondaryHistory: [],
      secondaryHistoryIndex: -1,
      activePane: "primary",
      splitRatio: 0.5,
      toggleSplitView: (initialPath) =>
        set((state) => {
          if (state.enabled) {
            return { enabled: false, activePane: "primary" };
          }
          const path = state.secondaryPath || initialPath || "/";
          const hasHistory = state.secondaryHistory.length > 0;
          return {
            enabled: true,
            secondaryPath: path,
            secondaryHistory: hasHistory ? state.secondaryHistory : [path],
            secondaryHistoryIndex: hasHistory ? state.secondaryHistoryIndex : 0,
            activePane: "secondary",
          };
        }),
      openSplitView: (path) =>
        set({
          enabled: true,
          secondaryPath: path,
          secondaryHistory: [path],
          secondaryHistoryIndex: 0,
          activePane: "secondary",
        }),
      closeSplitView: () => set({ enabled: false, activePane: "primary" }),
      setActivePane: (pane) => set({ activePane: pane }),
      navigateSecondary: (path) =>
        set((state) => {
          if (state.secondaryPath === path) return state;
          const nextHistory = state.secondaryHistory.slice(0, state.secondaryHistoryIndex + 1);
          nextHistory.push(path);
          return {
            secondaryPath: path,
            secondaryHistory: nextHistory,
            secondaryHistoryIndex: nextHistory.length - 1,
          };
        }),
      goBackSecondary: () =>
        set((state) => {
          if (state.secondaryHistoryIndex <= 0) return state;
          const nextIndex = state.secondaryHistoryIndex - 1;
          return {
            secondaryHistoryIndex: nextIndex,
            secondaryPath: state.secondaryHistory[nextIndex] ?? state.secondaryPath,
          };
        }),
      goForwardSecondary: () =>
        set((state) => {
          if (state.secondaryHistoryIndex >= state.secondaryHistory.length - 1) return state;
          const nextIndex = state.secondaryHistoryIndex + 1;
          return {
            secondaryHistoryIndex: nextIndex,
            secondaryPath: state.secondaryHistory[nextIndex] ?? state.secondaryPath,
          };
        }),
      setSplitRatio: (ratio) => set({ splitRatio: clampRatio(ratio) }),
    }),
    {
      name: "split-view-storage",
      partialize: (state) => ({
        secondaryPath: state.secondaryPath,
        splitRatio: state.splitRatio,
      }),
    }
  )
);

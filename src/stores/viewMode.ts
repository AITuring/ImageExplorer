import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ViewMode = "icon" | "list" | "column";

interface ViewModeState {
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
}

export const useViewMode = create<ViewModeState>()(
  persist(
    (set) => ({
      viewMode: "list",
      setViewMode: (mode) => set({ viewMode: mode }),
    }),
    {
      name: "view-mode-storage",
      merge: (persisted, current) => {
        const saved = (persisted as { viewMode?: unknown } | undefined)?.viewMode;
        return {
          ...current,
          viewMode:
            saved === "gallery" || saved === "icon"
              ? "icon"
              : saved === "column"
                ? "column"
                : "list",
        };
      },
    }
  )
);

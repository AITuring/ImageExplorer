import { create } from "zustand";
import { persist } from "zustand/middleware";

interface PhotoAnalysisModeState {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  toggle: () => void;
}

export const usePhotoAnalysisMode = create<PhotoAnalysisModeState>()(
  persist(
    (set) => ({
      enabled: false,
      setEnabled: (enabled) => set({ enabled }),
      toggle: () => set((state) => ({ enabled: !state.enabled })),
    }),
    {
      name: "photo-analysis-mode-storage",
    }
  )
);

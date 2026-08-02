import { create } from "zustand";
import type { PhotoAnalysisProgress } from "@/lib/photoAnalysis";

const EMPTY_PROGRESS: PhotoAnalysisProgress = {
  completed: 0,
  total: 0,
  isAnalyzing: false,
};

interface PhotoAnalysisProgressState {
  scopePath: string | null;
  progress: PhotoAnalysisProgress;
  setProgress: (scopePath: string, progress: PhotoAnalysisProgress) => void;
  clear: (scopePath: string) => void;
}

export const usePhotoAnalysisProgress = create<PhotoAnalysisProgressState>((set) => ({
  scopePath: null,
  progress: EMPTY_PROGRESS,
  setProgress: (scopePath, progress) => set({ scopePath, progress }),
  clear: (scopePath) =>
    set((state) =>
      state.scopePath === scopePath ? { scopePath: null, progress: EMPTY_PROGRESS } : state
    ),
}));

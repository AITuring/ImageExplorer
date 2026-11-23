import { create } from "zustand";

interface StorageAnalyzerDialogState {
  targetPath: string | null;
  initialTab: "space" | "duplicates";
  open: (path: string, tab?: "space" | "duplicates") => void;
  close: () => void;
}

export const useStorageAnalyzerDialog = create<StorageAnalyzerDialogState>((set) => ({
  targetPath: null,
  initialTab: "space",
  open: (path, tab = "space") => set({ targetPath: path, initialTab: tab }),
  close: () => set({ targetPath: null }),
}));

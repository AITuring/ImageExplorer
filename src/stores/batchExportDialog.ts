import { create } from "zustand";
import type { FileEntry } from "@/types";

interface BatchExportDialogState {
  isOpen: boolean;
  entries: FileEntry[];
  defaultDestDir: string;
  open: (entries: FileEntry[], defaultDestDir?: string) => void;
  close: () => void;
}

export const useBatchExportDialog = create<BatchExportDialogState>((set) => ({
  isOpen: false,
  entries: [],
  defaultDestDir: "",
  open: (entries, defaultDestDir = "") => set({ isOpen: true, entries, defaultDestDir }),
  close: () => set({ isOpen: false }),
}));

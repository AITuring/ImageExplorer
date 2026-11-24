import { create } from "zustand";
import type { FileEntry } from "@/types";

interface FileInfoDialogState {
  entries: FileEntry[];
  entry: FileEntry | null;
  open: (target: FileEntry | FileEntry[]) => void;
  close: () => void;
}

export const useFileInfoDialog = create<FileInfoDialogState>((set) => ({
  entries: [],
  entry: null,
  open: (target) => {
    const list = Array.isArray(target) ? target : [target];
    if (list.length === 0) return;
    set({ entries: list, entry: list[0] });
  },
  close: () => set({ entries: [], entry: null }),
}));

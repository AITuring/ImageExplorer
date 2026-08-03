import { create } from "zustand";
import type { FileEntry } from "@/types";

interface FileInfoDialogState {
  entry: FileEntry | null;
  open: (entry: FileEntry) => void;
  close: () => void;
}

export const useFileInfoDialog = create<FileInfoDialogState>((set) => ({
  entry: null,
  open: (entry) => set({ entry }),
  close: () => set({ entry: null }),
}));

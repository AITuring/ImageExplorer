import { create } from "zustand";
import type { FileEntry } from "@/types";

interface ExifSyncDialogState {
  isOpen: boolean;
  directory: string;
  selectedEntries: FileEntry[];
  open: (directory: string, selectedEntries?: FileEntry[]) => void;
  close: () => void;
}

export const useExifSyncDialog = create<ExifSyncDialogState>((set) => ({
  isOpen: false,
  directory: "",
  selectedEntries: [],
  open: (directory, selectedEntries = []) => set({ isOpen: true, directory, selectedEntries }),
  close: () => set({ isOpen: false }),
}));

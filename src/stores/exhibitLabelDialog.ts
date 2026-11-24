import { create } from "zustand";
import type { FileEntry } from "@/types";

interface ExhibitLabelDialogState {
  isOpen: boolean;
  directory: string;
  selectedEntries: FileEntry[];
  open: (directory: string, selectedEntries?: FileEntry[]) => void;
  close: () => void;
}

export const useExhibitLabelDialog = create<ExhibitLabelDialogState>((set) => ({
  isOpen: false,
  directory: "",
  selectedEntries: [],
  open: (directory, selectedEntries = []) => set({ isOpen: true, directory, selectedEntries }),
  close: () => set({ isOpen: false }),
}));

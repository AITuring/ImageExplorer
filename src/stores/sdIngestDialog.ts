import { create } from "zustand";

interface SdIngestDialogState {
  isOpen: boolean;
  initialSourceDir: string;
  open: (initialSourceDir?: string) => void;
  close: () => void;
}

export const useSdIngestDialog = create<SdIngestDialogState>((set) => ({
  isOpen: false,
  initialSourceDir: "",
  open: (initialSourceDir = "") => set({ isOpen: true, initialSourceDir }),
  close: () => set({ isOpen: false }),
}));

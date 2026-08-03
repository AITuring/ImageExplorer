import { create } from "zustand";

interface TrashDialogState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useTrashDialog = create<TrashDialogState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

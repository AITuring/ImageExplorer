import { create } from "zustand";

interface StatusBarState {
  path: string;
  totalCount: number;
  selectedCount: number;
  selectedBytes: number;
  loading: boolean;
  setStatus: (status: {
    path: string;
    totalCount: number;
    selectedCount: number;
    selectedBytes: number;
    loading: boolean;
  }) => void;
}

export const useStatusBar = create<StatusBarState>((set) => ({
  path: "",
  totalCount: 0,
  selectedCount: 0,
  selectedBytes: 0,
  loading: false,
  setStatus: (status) => set(status),
}));

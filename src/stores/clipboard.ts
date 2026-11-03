import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export type ClipboardOperation = "copy" | "cut" | null;

interface NativeFileClipboard {
  paths: string[];
  cut: boolean;
  changeCount: number;
}

export interface FileClipboardSnapshot {
  paths: string[];
  operation: Exclude<ClipboardOperation, null>;
  changeCount: number | null;
}

let clipboardRequest = 0;

interface ClipboardState {
  paths: string[];
  operation: ClipboardOperation;
  changeCount: number | null;
  copy: (paths: string[]) => Promise<void>;
  cut: (paths: string[]) => Promise<void>;
  refresh: () => Promise<void>;
  getForPaste: () => Promise<FileClipboardSnapshot | null>;
  consumeCut: (changeCount: number | null) => Promise<void>;
  clear: () => void;
  hasPending: () => boolean;
}

export const useClipboard = create<ClipboardState>((set, get) => ({
  paths: [],
  operation: null,
  changeCount: null,
  copy: async (paths) => {
    const request = ++clipboardRequest;
    set({ paths, operation: "copy", changeCount: null });
    try {
      const contents = await invoke<NativeFileClipboard>("write_file_clipboard", {
        paths,
        cut: false,
      });
      if (request === clipboardRequest) {
        set({ paths: contents.paths, operation: "copy", changeCount: contents.changeCount });
      }
    } catch (error) {
      console.error("Could not publish copied files to the system clipboard:", error);
    }
  },
  cut: async (paths) => {
    const request = ++clipboardRequest;
    set({ paths, operation: "cut", changeCount: null });
    try {
      const contents = await invoke<NativeFileClipboard>("write_file_clipboard", {
        paths,
        cut: true,
      });
      if (request === clipboardRequest) {
        set({ paths: contents.paths, operation: "cut", changeCount: contents.changeCount });
      }
    } catch (error) {
      console.error("Could not publish cut files to the system clipboard:", error);
    }
  },
  refresh: async () => {
    const request = ++clipboardRequest;
    try {
      const contents = await invoke<NativeFileClipboard>("read_file_clipboard");
      if (request !== clipboardRequest) return;
      set({
        paths: contents.paths,
        operation: contents.paths.length > 0 ? (contents.cut ? "cut" : "copy") : null,
        changeCount: contents.changeCount,
      });
    } catch (error) {
      console.error("Could not inspect the system file clipboard:", error);
    }
  },
  getForPaste: async () => {
    const request = ++clipboardRequest;
    try {
      const contents = await invoke<NativeFileClipboard>("read_file_clipboard");
      if (request !== clipboardRequest) return null;
      const operation = contents.cut ? "cut" : "copy";
      set({
        paths: contents.paths,
        operation: contents.paths.length > 0 ? operation : null,
        changeCount: contents.changeCount,
      });
      return contents.paths.length > 0
        ? { paths: contents.paths, operation, changeCount: contents.changeCount }
        : null;
    } catch {
      if (request !== clipboardRequest) return null;
      const { paths, operation, changeCount } = get();
      return paths.length > 0 && operation ? { paths, operation, changeCount } : null;
    }
  },
  consumeCut: async (changeCount) => {
    if (changeCount !== null) {
      try {
        const consumed = await invoke<boolean>("consume_cut_file_clipboard", {
          expectedChangeCount: changeCount,
        });
        if (!consumed) {
          await get().refresh();
          return;
        }
      } catch (error) {
        console.error("Could not consume the cut file clipboard:", error);
        await get().refresh();
        return;
      }
    }
    ++clipboardRequest;
    set({ paths: [], operation: null, changeCount: null });
  },
  clear: () => {
    ++clipboardRequest;
    set({ paths: [], operation: null, changeCount: null });
  },
  hasPending: () => get().paths.length > 0 && get().operation !== null,
}));

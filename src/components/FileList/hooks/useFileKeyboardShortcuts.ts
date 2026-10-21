import { useEffect, useRef } from "react";
import { FileEntry } from "@/types";
import type { ViewMode } from "@/stores/viewMode";
import { useClipboard } from "@/stores/clipboard";
import { registerKeyboardCommands } from "@/lib/keyboardShortcuts";

interface UseFileKeyboardShortcutsOptions {
  selectedPath: string | null;
  selectedPaths: string[];
  sortedEntries: FileEntry[];
  entries: FileEntry[];
  viewMode: ViewMode;
  gridColumns: number;
  legacyTabNumberShortcuts: boolean;
  setViewMode: (mode: ViewMode) => void;
  openEntry: (entry: FileEntry) => void;
  // 选择操作
  selectAll: (entries: FileEntry[]) => void;
  selectSingle: (path: string, index: number) => void;
  selectRange: (entries: FileEntry[], toIndex: number) => void;
  clearSelection: () => void;
  // 文件操作
  handleCopy: (entries: FileEntry[]) => void;
  handleCut: (entries: FileEntry[]) => void;
  handlePaste: () => Promise<void>;
  handlePasteAsMove: () => Promise<void>;
  handleDelete: (entries: FileEntry[]) => Promise<void>;
  handleNewFile: () => Promise<void>;
  handleNewFolder: () => Promise<void>;
}

function isModifierPressed(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

function matchesModifiedKey(event: KeyboardEvent, key: string): boolean {
  return (
    isModifierPressed(event) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === key
  );
}

export function useFileKeyboardShortcuts(options: UseFileKeyboardShortcutsOptions) {
  const clipboard = useClipboard();

  // Store current values so registered commands stay in sync without rebinding
  // the shared keyboard dispatcher on every selection or directory change.
  const optionsRef = useRef(options);
  const clipboardRef = useRef(clipboard);

  useEffect(() => {
    optionsRef.current = options;
    clipboardRef.current = clipboard;
  });

  useEffect(
    () =>
      registerKeyboardCommands([
        {
          id: "file.select-all",
          scope: "file-view",
          matches: (event) => matchesModifiedKey(event, "a"),
          enabled: () => optionsRef.current.sortedEntries.length > 0,
          run: () => optionsRef.current.selectAll(optionsRef.current.sortedEntries),
        },
        {
          id: "file.clear-selection",
          scope: "file-view",
          matches: (event) => event.key === "Escape",
          enabled: () => optionsRef.current.selectedPaths.length > 0,
          run: () => optionsRef.current.clearSelection(),
        },
        {
          id: "file.new-file",
          scope: "file-view",
          matches: (event) =>
            isModifierPressed(event) &&
            event.code === "KeyN" &&
            event.altKey &&
            !event.shiftKey,
          run: () => optionsRef.current.handleNewFile(),
        },
        {
          id: "file.new-folder",
          scope: "file-view",
          matches: (event) =>
            isModifierPressed(event) &&
            event.key.toLowerCase() === "n" &&
            event.shiftKey &&
            !event.altKey,
          run: () => optionsRef.current.handleNewFolder(),
        },
        {
          id: "file.copy",
          scope: "file-view",
          matches: (event) => matchesModifiedKey(event, "c"),
          enabled: () => optionsRef.current.selectedPaths.length > 0,
          run: () => {
            const current = optionsRef.current;
            const selectedEntries = current.entries.filter((entry) =>
              current.selectedPaths.includes(entry.path)
            );
            if (selectedEntries.length > 0) current.handleCopy(selectedEntries);
          },
        },
        {
          id: "file.cut",
          scope: "file-view",
          matches: (event) => matchesModifiedKey(event, "x"),
          enabled: () => optionsRef.current.selectedPaths.length > 0,
          run: () => {
            const current = optionsRef.current;
            const selectedEntries = current.entries.filter((entry) =>
              current.selectedPaths.includes(entry.path)
            );
            if (selectedEntries.length > 0) current.handleCut(selectedEntries);
          },
        },
        {
          id: "file.paste",
          scope: "file-view",
          matches: (event) => matchesModifiedKey(event, "v"),
          enabled: () => clipboardRef.current.hasPending(),
          run: () => optionsRef.current.handlePaste(),
        },
        {
          id: "file.paste-as-move",
          scope: "file-view",
          priority: 1,
          matches: (event) =>
            isModifierPressed(event) &&
            event.code === "KeyV" &&
            event.altKey &&
            !event.shiftKey,
          enabled: () => clipboardRef.current.hasPending(),
          run: () => optionsRef.current.handlePasteAsMove(),
        },
        {
          id: "file.delete",
          scope: "file-view",
          matches: (event) =>
            isModifierPressed(event) && event.key === "Backspace" && !event.altKey,
          enabled: () => optionsRef.current.selectedPaths.length > 0,
          run: () => {
            const current = optionsRef.current;
            const selectedEntries = current.entries.filter((entry) =>
              current.selectedPaths.includes(entry.path)
            );
            if (selectedEntries.length > 0) void current.handleDelete(selectedEntries);
          },
        },
        {
          id: "file.open",
          scope: "file-view",
          matches: (event) => matchesModifiedKey(event, "o"),
          enabled: () => Boolean(optionsRef.current.selectedPath),
          run: () => {
            const current = optionsRef.current;
            const entry = current.entries.find((item) => item.path === current.selectedPath);
            if (entry) current.openEntry(entry);
          },
        },
        {
          id: "file.view-mode",
          scope: "file-view",
          matches: (event) =>
            isModifierPressed(event) &&
            !event.shiftKey &&
            !event.altKey &&
            ["1", "2", "3", "4"].includes(event.key),
          enabled: () => !optionsRef.current.legacyTabNumberShortcuts,
          run: (event) => {
            const modes: Record<string, ViewMode> = {
              "1": "icon",
              "2": "list",
              "3": "column",
              "4": "gallery",
            };
            const mode = modes[event.key];
            if (mode) optionsRef.current.setViewMode(mode);
          },
        },
        {
          id: "file.move-selection",
          scope: "file-view",
          matches: (event) =>
            !isModifierPressed(event) &&
            !event.altKey &&
            (event.key === "ArrowDown" ||
              event.key === "ArrowUp" ||
              (optionsRef.current.viewMode === "icon" &&
                (event.key === "ArrowLeft" || event.key === "ArrowRight"))),
          enabled: () => optionsRef.current.sortedEntries.length > 0,
          run: (event) => {
            const current = optionsRef.current;
            const currentIndex = current.selectedPath
              ? current.sortedEntries.findIndex((entry) => entry.path === current.selectedPath)
              : -1;
            let step = 0;
            if (current.viewMode === "icon") {
              if (event.key === "ArrowDown") step = current.gridColumns;
              if (event.key === "ArrowUp") step = -current.gridColumns;
              if (event.key === "ArrowRight") step = 1;
              if (event.key === "ArrowLeft") step = -1;
            } else {
              if (event.key === "ArrowDown") step = 1;
              if (event.key === "ArrowUp") step = -1;
            }
            const newIndex =
              currentIndex < 0
                ? 0
                : Math.max(
                    0,
                    Math.min(current.sortedEntries.length - 1, currentIndex + step)
                  );
            if (event.shiftKey) {
              current.selectRange(current.sortedEntries, newIndex);
            } else {
              current.selectSingle(current.sortedEntries[newIndex].path, newIndex);
            }
          },
        },
      ]),
    []
  );
}

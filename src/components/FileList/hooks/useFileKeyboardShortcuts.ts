import { useEffect, useMemo, useRef } from "react";
import { FileEntry, FileCommandActions } from "@/types";
import type { ViewMode } from "@/stores/viewMode";
import { useClipboard } from "@/stores/clipboard";
import { registerKeyboardCommands } from "@/lib/keyboardShortcuts";
import { isCommandEnabled, registerAppCommands, runCommand } from "@/lib/commands";
import { viewModeCommands } from "@/lib/viewModeCommands";

interface UseFileKeyboardShortcutsOptions {
  selectedPath: string | null;
  selectedPaths: string[];
  editingPath: string | null;
  sortedEntries: FileEntry[];
  entries: FileEntry[];
  viewMode: ViewMode;
  gridColumns: number;
  canMutate: boolean;
  legacyTabNumberShortcuts: boolean;
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
  handleRename: (entry: FileEntry) => void;
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

export function useFileKeyboardShortcuts(options: UseFileKeyboardShortcutsOptions): FileCommandActions {
  const clipboard = useClipboard();

  // Keep registered commands stable while their handlers read current selection and operations.
  const optionsRef = useRef(options);
  const clipboardRef = useRef(clipboard);

  useEffect(() => {
    optionsRef.current = options;
    clipboardRef.current = clipboard;
  });

  const commands = useMemo<FileCommandActions>(() => {
    const getSelectedEntries = () => {
      const current = optionsRef.current;
      return current.entries.filter((entry) => current.selectedPaths.includes(entry.path));
    };

    const getSelectedEntry = () => {
      const current = optionsRef.current;
      return current.entries.find((entry) => entry.path === current.selectedPath);
    };

    return {
      selectAll: {
        id: "file.select-all",
        shortcut: "⌘A",
        enabled: () => optionsRef.current.sortedEntries.length > 0,
        run: () => optionsRef.current.selectAll(optionsRef.current.sortedEntries),
      },
      clearSelection: {
        id: "file.clear-selection",
        enabled: () => optionsRef.current.selectedPaths.length > 0,
        run: () => optionsRef.current.clearSelection(),
      },
      open: {
        id: "file.open",
        shortcut: "⌘O",
        enabled: (entry) => Boolean(entry ?? getSelectedEntry()),
        run: (entry) => {
          const target = entry ?? getSelectedEntry();
          if (target) optionsRef.current.openEntry(target);
        },
      },
      copy: {
        id: "file.copy",
        shortcut: "⌘C",
        enabled: (entries) => (entries ?? getSelectedEntries()).length > 0,
        run: (entries) => optionsRef.current.handleCopy(entries ?? getSelectedEntries()),
      },
      cut: {
        id: "file.cut",
        shortcut: "⌘X",
        enabled: (entries) => {
          const targets = entries ?? getSelectedEntries();
          return targets.length > 0 && targets.every((entry) => !entry.readonly);
        },
        run: (entries) => optionsRef.current.handleCut(entries ?? getSelectedEntries()),
      },
      paste: {
        id: "file.paste",
        shortcut: "⌘V",
        enabled: () => clipboardRef.current.hasPending(),
        run: () => optionsRef.current.handlePaste(),
      },
      pasteAsMove: {
        id: "file.paste-as-move",
        shortcut: "⌘⌥V",
        enabled: () => clipboardRef.current.hasPending(),
        run: () => optionsRef.current.handlePasteAsMove(),
      },
      delete: {
        id: "file.delete",
        shortcut: "⌘⌫",
        enabled: (entries) => {
          const targets = entries ?? getSelectedEntries();
          return targets.length > 0 && targets.every((entry) => !entry.readonly);
        },
        run: (entries) => optionsRef.current.handleDelete(entries ?? getSelectedEntries()),
      },
      rename: {
        id: "file.rename",
        shortcut: "Return",
        enabled: (entry) => {
          const target = entry ?? getSelectedEntry();
          return Boolean(target && !target.readonly && !optionsRef.current.editingPath);
        },
        run: (entry) => {
          const target = entry ?? getSelectedEntry();
          if (target) optionsRef.current.handleRename(target);
        },
      },
      newFile: {
        id: "file.new-file",
        shortcut: "⌘⌥N",
        enabled: () => optionsRef.current.canMutate,
        run: () => optionsRef.current.handleNewFile(),
      },
      newFolder: {
        id: "file.new-folder",
        shortcut: "⌘⇧N",
        enabled: () => optionsRef.current.canMutate,
        run: () => optionsRef.current.handleNewFolder(),
      },
    };
  }, []);

  useEffect(() => {
    return registerAppCommands(Object.values(commands));
  }, [commands]);

  useEffect(
    () =>
      registerKeyboardCommands([
        {
          id: "file.select-all",
          scope: "file-view",
          matches: (event) => matchesModifiedKey(event, "a"),
          enabled: () => isCommandEnabled(commands.selectAll),
          run: () => { runCommand(commands.selectAll); },
        },
        {
          id: "file.clear-selection",
          scope: "file-view",
          matches: (event) => event.key === "Escape",
          enabled: () => isCommandEnabled(commands.clearSelection),
          run: () => { runCommand(commands.clearSelection); },
        },
        {
          id: "file.copy",
          scope: "file-view",
          matches: (event) => matchesModifiedKey(event, "c"),
          enabled: () => isCommandEnabled(commands.copy),
          run: () => { runCommand(commands.copy); },
        },
        {
          id: "file.cut",
          scope: "file-view",
          matches: (event) => matchesModifiedKey(event, "x"),
          enabled: () => isCommandEnabled(commands.cut),
          run: () => { runCommand(commands.cut); },
        },
        {
          id: "file.paste",
          scope: "file-view",
          matches: (event) => matchesModifiedKey(event, "v"),
          enabled: () => isCommandEnabled(commands.paste),
          run: () => { runCommand(commands.paste); },
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
          enabled: () => isCommandEnabled(commands.pasteAsMove),
          run: () => { runCommand(commands.pasteAsMove); },
        },
        {
          id: "file.delete",
          scope: "file-view",
          matches: (event) =>
            isModifierPressed(event) && event.key === "Backspace" && !event.altKey,
          enabled: () => isCommandEnabled(commands.delete),
          run: () => { runCommand(commands.delete); },
        },
        {
          id: "file.open",
          scope: "file-view",
          matches: (event) => matchesModifiedKey(event, "o"),
          enabled: () => isCommandEnabled(commands.open),
          run: () => { runCommand(commands.open); },
        },
        {
          id: "file.rename",
          scope: "file-view",
          priority: 5,
          matches: (event) => event.key === "Enter",
          enabled: () => isCommandEnabled(commands.rename),
          run: () => { runCommand(commands.rename); },
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
            if (mode) runCommand(viewModeCommands[mode]);
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
    [commands]
  );

  return commands;
}

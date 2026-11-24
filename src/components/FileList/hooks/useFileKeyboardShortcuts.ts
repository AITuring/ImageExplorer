import { useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileEntry, FileCommandActions } from "@/types";
import type { FileOperationSnapshot } from "@/types";
import type { ViewMode } from "@/stores/viewMode";
import { registerKeyboardCommands } from "@/lib/keyboardShortcuts";
import { isCommandEnabled, registerAppCommands, runCommand } from "@/lib/commands";
import { viewModeCommands } from "@/lib/viewModeCommands";
import { FINDER_TAG_PRESETS } from "@/lib/finderTags";
import { isAnalyzablePhoto } from "@/lib/photoAnalysis";
import type { PhotoFlag } from "@/lib/photoCulling";
import { findTypeAheadMatch } from "./finderListModel";

const TYPE_AHEAD_RESET_MS = 750;

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
  // 导航与辅助
  onOpenParent?: () => void;
  onGoBack?: () => void;
  onGoForward?: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onToggleHiddenFiles?: () => void;
  onFocusFilterBar?: () => void;
  onToggleTag?: (entries: FileEntry[], tag: string) => void;
  onSetFlag?: (entries: FileEntry[], flag: PhotoFlag) => void;
  onSetRating?: (entries: FileEntry[], rating: number) => void;
  cullAutoAdvance?: boolean;
  onScrollToIndex?: (index: number) => void;
  onColumnNavigateLeft?: () => boolean;
  onColumnNavigateRight?: () => Promise<boolean>;
  onColumnFocusEntry?: (entry: FileEntry) => Promise<void>;
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
  handleDuplicate: (entries: FileEntry[]) => Promise<void>;
  handleGetInfo: (entry: FileEntry) => void;
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
    isModifierPressed(event) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === key
  );
}

export function useFileKeyboardShortcuts(
  options: UseFileKeyboardShortcutsOptions
): FileCommandActions {
  // Keep registered commands stable while their handlers read current selection and operations.
  const optionsRef = useRef(options);
  const typeAheadRef = useRef({ buffer: "", lastTime: 0 });

  useEffect(() => {
    optionsRef.current = options;
  });

  const commands = useMemo<FileCommandActions>(() => {
    const getSelectedEntries = () => {
      const current = optionsRef.current;
      if (current.selectedPaths.length === 0) return [];
      const selectedSet = new Set(current.selectedPaths);
      return current.entries.filter((entry) => selectedSet.has(entry.path));
    };

    const getSelectedEntry = () => {
      const current = optionsRef.current;
      if (!current.selectedPath) return undefined;
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
        // The system pasteboard can change before the focus refresh finishes.
        // Read it when the shortcut runs instead of relying on cached state.
        enabled: () => optionsRef.current.canMutate,
        run: () => optionsRef.current.handlePaste(),
      },
      pasteAsMove: {
        id: "file.paste-as-move",
        shortcut: "⌘⌥V",
        enabled: () => optionsRef.current.canMutate,
        run: () => optionsRef.current.handlePasteAsMove(),
      },
      duplicate: {
        id: "file.duplicate",
        shortcut: "⌘D",
        enabled: (entries) =>
          optionsRef.current.canMutate && (entries ?? getSelectedEntries()).length > 0,
        run: (entries) => optionsRef.current.handleDuplicate(entries ?? getSelectedEntries()),
      },
      getInfo: {
        id: "file.get-info",
        shortcut: "⌘I",
        enabled: (entry) => Boolean(entry ?? getSelectedEntry()),
        run: (entry) => {
          const target = entry ?? getSelectedEntry();
          if (target) optionsRef.current.handleGetInfo(target);
        },
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
          run: () => {
            runCommand(commands.selectAll);
          },
        },
        {
          id: "file.clear-selection",
          scope: "file-view",
          matches: (event) => event.key === "Escape",
          enabled: () => isCommandEnabled(commands.clearSelection),
          run: () => {
            typeAheadRef.current = { buffer: "", lastTime: 0 };
            runCommand(commands.clearSelection);
          },
        },
        {
          id: "file.copy",
          scope: "file-view",
          matches: (event) => matchesModifiedKey(event, "c"),
          enabled: () => isCommandEnabled(commands.copy),
          run: () => {
            runCommand(commands.copy);
          },
        },
        {
          id: "file.cut",
          scope: "file-view",
          matches: (event) => matchesModifiedKey(event, "x"),
          enabled: () => isCommandEnabled(commands.cut),
          run: () => {
            runCommand(commands.cut);
          },
        },
        {
          id: "file.paste",
          scope: "file-view",
          matches: (event) => matchesModifiedKey(event, "v"),
          enabled: () => isCommandEnabled(commands.paste),
          run: () => {
            runCommand(commands.paste);
          },
        },
        {
          id: "file.paste-as-move",
          scope: "file-view",
          priority: 1,
          matches: (event) =>
            isModifierPressed(event) && event.code === "KeyV" && event.altKey && !event.shiftKey,
          enabled: () => isCommandEnabled(commands.pasteAsMove),
          run: () => {
            runCommand(commands.pasteAsMove);
          },
        },
        {
          id: "file.duplicate",
          scope: "file-view",
          matches: (event) => matchesModifiedKey(event, "d"),
          enabled: () => isCommandEnabled(commands.duplicate),
          run: () => {
            runCommand(commands.duplicate);
          },
        },
        {
          id: "file.get-info",
          scope: "file-view",
          matches: (event) => matchesModifiedKey(event, "i"),
          enabled: () => isCommandEnabled(commands.getInfo),
          run: () => {
            runCommand(commands.getInfo);
          },
        },
        {
          id: "file.undo-last-operation",
          scope: "file-view",
          matches: (event) => matchesModifiedKey(event, "z"),
          run: async () => {
            const operations = await invoke<FileOperationSnapshot[]>("get_file_operations");
            const latest = operations
              .filter((operation) => operation.undo_status === "available")
              .sort(
                (left, right) =>
                  right.started_at - left.started_at || right.id.localeCompare(left.id)
              )[0];
            if (latest) {
              await invoke("undo_file_operation", { operationId: latest.id });
            }
          },
        },
        {
          id: "file.delete",
          scope: "file-view",
          matches: (event) =>
            isModifierPressed(event) && event.key === "Backspace" && !event.altKey,
          enabled: () => isCommandEnabled(commands.delete),
          run: () => {
            runCommand(commands.delete);
          },
        },
        {
          id: "file.open",
          scope: "file-view",
          matches: (event) =>
            matchesModifiedKey(event, "o") ||
            (isModifierPressed(event) &&
              !event.shiftKey &&
              !event.altKey &&
              event.key === "ArrowDown"),
          enabled: () => isCommandEnabled(commands.open),
          run: () => {
            runCommand(commands.open);
          },
        },
        {
          id: "file.open-parent",
          scope: "file-view",
          matches: (event) =>
            isModifierPressed(event) && !event.shiftKey && !event.altKey && event.key === "ArrowUp",
          enabled: () => Boolean(optionsRef.current.onOpenParent),
          run: () => {
            optionsRef.current.onOpenParent?.();
          },
        },
        {
          id: "file.history-back",
          scope: "file-view",
          matches: (event) =>
            isModifierPressed(event) &&
            !event.shiftKey &&
            !event.altKey &&
            event.code === "BracketLeft",
          enabled: () => Boolean(optionsRef.current.canGoBack && optionsRef.current.onGoBack),
          run: () => {
            optionsRef.current.onGoBack?.();
          },
        },
        {
          id: "file.history-forward",
          scope: "file-view",
          matches: (event) =>
            isModifierPressed(event) &&
            !event.shiftKey &&
            !event.altKey &&
            event.code === "BracketRight",
          enabled: () => Boolean(optionsRef.current.canGoForward && optionsRef.current.onGoForward),
          run: () => {
            optionsRef.current.onGoForward?.();
          },
        },
        {
          id: "file.toggle-hidden",
          scope: "file-view",
          matches: (event) =>
            isModifierPressed(event) &&
            event.shiftKey &&
            !event.altKey &&
            (event.code === "Period" || event.key === "." || event.key === ">"),
          enabled: () => Boolean(optionsRef.current.onToggleHiddenFiles),
          run: () => {
            optionsRef.current.onToggleHiddenFiles?.();
          },
        },
        {
          id: "file.focus-filter",
          scope: "file-view",
          matches: (event) =>
            isModifierPressed(event) && event.altKey && !event.shiftKey && event.code === "KeyF",
          enabled: () => Boolean(optionsRef.current.onFocusFilterBar),
          run: () => {
            optionsRef.current.onFocusFilterBar?.();
          },
        },
        {
          id: "file.gallery-quick-tag",
          scope: "file-view",
          priority: 2,
          matches: (event) =>
            (optionsRef.current.viewMode === "gallery" ||
              Boolean(optionsRef.current.cullAutoAdvance)) &&
            !isModifierPressed(event) &&
            !event.altKey &&
            !event.shiftKey &&
            /^[1-7]$/.test(event.key),
          enabled: () =>
            Boolean(
              optionsRef.current.onToggleTag &&
              !optionsRef.current.editingPath &&
              optionsRef.current.selectedPaths.length > 0
            ),
          run: (event) => {
            const preset = FINDER_TAG_PRESETS[Number(event.key) - 1];
            if (!preset) return;
            const current = optionsRef.current;
            const selectedSet = new Set(current.selectedPaths);
            const targets = current.entries.filter((entry) => selectedSet.has(entry.path));
            if (targets.length > 0) {
              current.onToggleTag?.(targets, preset.id);
              if (current.cullAutoAdvance && current.selectedPath) {
                const idx = current.sortedEntries.findIndex((e) => e.path === current.selectedPath);
                if (idx >= 0 && idx + 1 < current.sortedEntries.length) {
                  current.selectSingle(current.sortedEntries[idx + 1].path, idx + 1);
                  current.onScrollToIndex?.(idx + 1);
                }
              }
            }
          },
        },
        {
          id: "file.cull-flag",
          scope: "file-view",
          priority: 2,
          matches: (event) => {
            if (isModifierPressed(event) || event.altKey || event.shiftKey) return false;
            const lower = event.key.toLowerCase();
            if (lower !== "p" && lower !== "x" && lower !== "u") return false;
            const current = optionsRef.current;
            if (current.viewMode === "gallery" || current.cullAutoAdvance) return true;
            // In list/icon views without auto-advance, only intercept P/X/U when
            // not mid-type-ahead and the selection consists of photos.
            const now = Date.now();
            if (now - typeAheadRef.current.lastTime <= TYPE_AHEAD_RESET_MS) return false;
            const selectedSet = new Set(current.selectedPaths);
            const targets = current.entries.filter((entry) => selectedSet.has(entry.path));
            return targets.length > 0 && targets.every(isAnalyzablePhoto);
          },
          enabled: () =>
            Boolean(
              optionsRef.current.onSetFlag &&
              !optionsRef.current.editingPath &&
              optionsRef.current.selectedPaths.length > 0
            ),
          run: (event) => {
            const current = optionsRef.current;
            const selectedSet = new Set(current.selectedPaths);
            const targets = current.entries.filter((entry) => selectedSet.has(entry.path));
            if (targets.length === 0) return;
            const lower = event.key.toLowerCase();
            const flag: PhotoFlag = lower === "p" ? "pick" : lower === "x" ? "reject" : "none";
            current.onSetFlag?.(targets, flag);
            if (current.cullAutoAdvance && current.selectedPath) {
              const idx = current.sortedEntries.findIndex((e) => e.path === current.selectedPath);
              if (idx >= 0 && idx + 1 < current.sortedEntries.length) {
                current.selectSingle(current.sortedEntries[idx + 1].path, idx + 1);
                current.onScrollToIndex?.(idx + 1);
              }
            }
          },
        },
        {
          id: "file.cull-rating",
          scope: "file-view",
          priority: 2,
          matches: (event) =>
            event.shiftKey &&
            !isModifierPressed(event) &&
            !event.altKey &&
            /^Digit[0-5]$/.test(event.code),
          enabled: () =>
            Boolean(
              optionsRef.current.onSetRating &&
              !optionsRef.current.editingPath &&
              optionsRef.current.selectedPaths.length > 0
            ),
          run: (event) => {
            const current = optionsRef.current;
            const selectedSet = new Set(current.selectedPaths);
            const targets = current.entries.filter((entry) => selectedSet.has(entry.path));
            if (targets.length === 0) return;
            const rating = Number(event.code.slice(5));
            current.onSetRating?.(targets, rating);
            if (current.cullAutoAdvance && current.selectedPath) {
              const idx = current.sortedEntries.findIndex((e) => e.path === current.selectedPath);
              if (idx >= 0 && idx + 1 < current.sortedEntries.length) {
                current.selectSingle(current.sortedEntries[idx + 1].path, idx + 1);
                current.onScrollToIndex?.(idx + 1);
              }
            }
          },
        },
        {
          id: "file.rename",
          scope: "file-view",
          priority: 5,
          matches: (event) => event.key === "Enter",
          enabled: () => isCommandEnabled(commands.rename),
          run: () => {
            runCommand(commands.rename);
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
            if (mode) runCommand(viewModeCommands[mode]);
          },
        },
        {
          id: "file.column-navigate",
          scope: "file-view",
          matches: (event) =>
            optionsRef.current.viewMode === "column" &&
            !isModifierPressed(event) &&
            !event.altKey &&
            !event.shiftKey &&
            (event.key === "ArrowLeft" || event.key === "ArrowRight"),
          enabled: () =>
            Boolean(
              optionsRef.current.onColumnNavigateLeft || optionsRef.current.onColumnNavigateRight
            ),
          run: async (event) => {
            if (event.key === "ArrowLeft") {
              optionsRef.current.onColumnNavigateLeft?.();
            } else {
              await optionsRef.current.onColumnNavigateRight?.();
            }
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
              ((optionsRef.current.viewMode === "icon" ||
                optionsRef.current.viewMode === "gallery") &&
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
            } else if (current.viewMode === "gallery") {
              if (event.key === "ArrowDown" || event.key === "ArrowRight") step = 1;
              if (event.key === "ArrowUp" || event.key === "ArrowLeft") step = -1;
            } else {
              if (event.key === "ArrowDown") step = 1;
              if (event.key === "ArrowUp") step = -1;
            }
            const newIndex =
              currentIndex < 0
                ? 0
                : Math.max(0, Math.min(current.sortedEntries.length - 1, currentIndex + step));
            const nextEntry = current.sortedEntries[newIndex];
            if (!nextEntry) return;
            if (event.shiftKey) {
              current.selectRange(current.sortedEntries, newIndex);
            } else {
              current.selectSingle(nextEntry.path, newIndex);
              if (current.viewMode === "column") {
                void current.onColumnFocusEntry?.(nextEntry);
              }
            }
            current.onScrollToIndex?.(newIndex);
          },
        },
        {
          id: "file.type-ahead",
          scope: "file-view",
          priority: -10,
          matches: (event) => {
            if (isModifierPressed(event) || event.altKey) return false;
            if (event.key.length !== 1) return false;
            // Reserve leading Space for Quick Look; allow Space inside a multi-character query.
            const now = Date.now();
            const activeBuffer =
              now - typeAheadRef.current.lastTime <= TYPE_AHEAD_RESET_MS
                ? typeAheadRef.current.buffer
                : "";
            if (event.key === " " && activeBuffer.length === 0) return false;
            return true;
          },
          enabled: () =>
            !optionsRef.current.editingPath && optionsRef.current.sortedEntries.length > 0,
          run: (event) => {
            const current = optionsRef.current;
            const now = Date.now();
            const isExpired = now - typeAheadRef.current.lastTime > TYPE_AHEAD_RESET_MS;
            const prevBuffer = isExpired ? "" : typeAheadRef.current.buffer;
            const pressed = event.key;
            const isRepeatSingle =
              prevBuffer.length === 1 &&
              prevBuffer.toLocaleLowerCase() === pressed.toLocaleLowerCase();
            const nextQuery = isRepeatSingle ? pressed : prevBuffer + pressed;

            typeAheadRef.current = { buffer: nextQuery, lastTime: now };

            const currentIndex = current.selectedPath
              ? current.sortedEntries.findIndex((entry) => entry.path === current.selectedPath)
              : -1;
            let matchIndex = findTypeAheadMatch(
              current.sortedEntries,
              nextQuery,
              currentIndex,
              isRepeatSingle
            );
            // If multi-char prefix has no match, restart search with just the pressed character.
            if (matchIndex < 0 && nextQuery.length > 1) {
              typeAheadRef.current = { buffer: pressed, lastTime: now };
              matchIndex = findTypeAheadMatch(current.sortedEntries, pressed, currentIndex, false);
            }
            if (matchIndex >= 0) {
              const target = current.sortedEntries[matchIndex];
              current.selectSingle(target.path, matchIndex);
              if (current.viewMode === "column") {
                void current.onColumnFocusEntry?.(target);
              }
              current.onScrollToIndex?.(matchIndex);
            }
          },
        },
      ]),
    [commands]
  );

  return commands;
}

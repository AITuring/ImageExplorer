import { memo, useState, useEffect, useCallback, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useVirtualizer } from "@tanstack/react-virtual";
import { DIR_CHANGE_DEBOUNCE_MS } from "@/constants/config";
import { ChevronRight } from "lucide-react";
import { FileEntry } from "@/types";
import { CompactFileThumbnail } from "./CompactFileThumbnail";
import { FinderTagDots } from "@/components/FinderTagDots";
import { filterHiddenEntries } from "@/utils/file";
import { sortFileEntries } from "../hooks/useFileSort";
import { readFileDragData } from "@/lib/dragData";
import { makeNativeFileDragGestureHandlers } from "@/lib/nativeFileDragGesture";
import { AppContextMenu } from "@/components/AppContextMenu";
import { ColumnFilePreview } from "./ColumnFilePreview";
import { RequestGeneration } from "@/lib/requestGeneration";
import { Input } from "@/components/ui/input";
import { COLUMN_VIEW_WIDTH_MAX, COLUMN_VIEW_WIDTH_MIN, useViewMode } from "@/stores/viewMode";
import type { FileActions } from "@/types";

const COLUMN_ROW_HEIGHT = 32;
const COLUMN_AUTOFIT_MIN = 180;
const COLUMN_AUTOFIT_MAX = 440;

let textMeasureCanvas: HTMLCanvasElement | null = null;

function computeColumnAutoFitWidth(entries: FileEntry[]): number {
  if (entries.length === 0) return COLUMN_AUTOFIT_MIN;

  let ctx: CanvasRenderingContext2D | null = null;
  if (typeof document !== "undefined") {
    textMeasureCanvas ??= document.createElement("canvas");
    ctx = textMeasureCanvas.getContext("2d");
    if (ctx) {
      ctx.font = '14px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif';
    }
  }

  let maxRowWidth = COLUMN_AUTOFIT_MIN;
  // Cap scan at 500 entries so auto-fit stays instant even on huge folders.
  const limit = Math.min(entries.length, 500);
  for (let i = 0; i < limit; i++) {
    const entry = entries[i];
    const nameWidth = ctx ? ctx.measureText(entry.name).width : entry.name.length * 8.2;
    const tagAllowance = entry.tags && entry.tags.length > 0 ? 28 : 0;
    const chevronAllowance = entry.is_dir ? 20 : 0;
    // Left/right padding (16) + thumbnail (20) + gap (8) + breathing room (18)
    const rowWidth = Math.ceil(nameWidth + 62 + tagAllowance + chevronAllowance);
    if (rowWidth > maxRowWidth) maxRowWidth = rowWidth;
  }

  return Math.max(COLUMN_AUTOFIT_MIN, Math.min(COLUMN_AUTOFIT_MAX, maxRowWidth));
}

export interface ColumnNavigationHandle {
  navigateLeft: () => boolean;
  navigateRight: () => Promise<boolean>;
  focusEntry: (entry: FileEntry) => Promise<void>;
}

export interface ColumnSelectionContext {
  rootPath: string;
  locationPath: string;
  activeEntries: FileEntry[];
  visibleEntries: FileEntry[];
}

interface FileColumnViewProps {
  currentPath: string;
  rootEntries?: FileEntry[];
  selectedPaths: string[];
  focusedPath: string | null;
  selectedFileEntries: FileEntry[];
  fileActions: FileActions;
  editingPath: string | null;
  editValue: string;
  onEditValueChange: (value: string) => void;
  onSubmitRename: () => void;
  onCancelRename: () => void;
  onContextChange: (context: ColumnSelectionContext | null) => void;
  navigationRef?: React.RefObject<ColumnNavigationHandle | null>;
  onSelectSingle: (path: string, index: number) => void;
  onClick: (
    entry: FileEntry,
    index: number,
    columnEntries: FileEntry[],
    e: React.MouseEvent
  ) => void;
  onDoubleClick: (entry: FileEntry) => void;
  onNavigate: (path: string) => void;
  handleMove: (src: string | string[], dest: string) => void;
  handleCopyTo: (src: string | string[], dest: string) => void;
  showHiddenFiles: boolean;
}

interface ColumnData {
  path: string;
  entries: FileEntry[];
  selectedPath: string | null;
}

interface ColumnPaneProps {
  column: ColumnData;
  colIdx: number;
  width: number;
  onResizeWidth: (columnPath: string, width: number, applyAll: boolean) => void;
  onAutoFitWidth: (columnPath: string, entries: FileEntry[], applyAll: boolean) => void;
  selectedPaths: string[];
  selectedPathSet: ReadonlySet<string>;
  focusedPath: string | null;
  selectedFileEntries: FileEntry[];
  fileActions: FileActions;
  editingPath: string | null;
  editValue: string;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  onEditValueChange: (value: string) => void;
  onSubmitRename: () => void;
  onCancelRename: () => void;
  onSelect: (colIdx: number, entry: FileEntry, entryIdx: number, e: React.MouseEvent) => void;
  onDoubleClick: (entry: FileEntry) => void;
  handleMove: (src: string | string[], dest: string) => void;
  handleCopyTo: (src: string | string[], dest: string) => void;
}

const ColumnPane = memo(function ColumnPane({
  column,
  colIdx,
  width,
  onResizeWidth,
  onAutoFitWidth,
  selectedPaths,
  selectedPathSet,
  focusedPath,
  selectedFileEntries,
  fileActions,
  editingPath,
  editValue,
  renameInputRef,
  onEditValueChange,
  onSubmitRename,
  onCancelRename,
  onSelect,
  onDoubleClick,
  handleMove,
  handleCopyTo,
}: ColumnPaneProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isResizing, setIsResizing] = useState(false);

  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = width;
      setIsResizing(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const nextWidth = Math.max(
          COLUMN_VIEW_WIDTH_MIN,
          Math.min(COLUMN_VIEW_WIDTH_MAX, Math.round(startWidth + moveEvent.clientX - startX))
        );
        onResizeWidth(column.path, nextWidth, moveEvent.altKey);
      };

      const handlePointerUp = () => {
        setIsResizing(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    },
    [column.path, onResizeWidth, width]
  );

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: column.entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => COLUMN_ROW_HEIGHT,
    overscan: 8,
    useAnimationFrameWithResizeObserver: true,
  });

  useEffect(() => {
    if (!focusedPath) return;
    const focusedIndex = column.entries.findIndex((entry) => entry.path === focusedPath);
    if (focusedIndex >= 0) {
      virtualizer.scrollToIndex(focusedIndex, { align: "auto" });
    }
  }, [column.entries, focusedPath, virtualizer]);

  const rangeStart = virtualizer.range?.startIndex ?? 0;
  const rangeEnd = virtualizer.range?.endIndex ?? -1;

  return (
    <div
      style={{ width: `${width}px` }}
      className="border-border/30 relative flex h-full shrink-0 flex-col border-r last:border-r-0"
    >
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {column.entries.length === 0 ? (
          <div className="text-muted-foreground flex h-20 items-center justify-center text-xs">
            Empty
          </div>
        ) : (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const entry = column.entries[virtualItem.index];
              if (!entry) return null;
              const entryIdx = virtualItem.index;
              const isSelected = selectedPathSet.has(entry.path);
              const isColumnSelected = column.selectedPath === entry.path;
              const dragPaths = isSelected ? selectedPaths : [entry.path];
              const nativeDragHandlers = makeNativeFileDragGestureHandlers(dragPaths);
              const isInViewport = entryIdx >= rangeStart && entryIdx <= rangeEnd;
              return (
                <div
                  key={entry.path}
                  data-index={entryIdx}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: `${virtualItem.size}px`,
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <AppContextMenu
                    type={entry.is_dir ? "folder" : "file"}
                    entry={entry}
                    selectedEntries={selectedFileEntries}
                    fileActions={fileActions}
                  >
                    <div
                      {...nativeDragHandlers}
                      data-selected={isSelected}
                      data-file-path={entry.path}
                      className={`finder-column-row flex h-full cursor-default items-center gap-2 px-2 py-1 text-sm transition-colors ${
                        isSelected || isColumnSelected ? "bg-accent" : "hover:bg-accent/50"
                      } ${focusedPath === entry.path ? "outline-primary outline outline-1 outline-offset-[-1px]" : ""}`}
                      onClick={(e) => onSelect(colIdx, entry, entryIdx, e)}
                      onDoubleClick={() => onDoubleClick(entry)}
                      onDragOver={(event) => {
                        if (!entry.is_dir) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = event.altKey ? "copy" : "move";
                        event.currentTarget.classList.add("bg-primary/20");
                      }}
                      onDragLeave={(event) => {
                        if (
                          !entry.is_dir ||
                          event.currentTarget.contains(event.relatedTarget as Node)
                        ) {
                          return;
                        }
                        event.currentTarget.classList.remove("bg-primary/20");
                      }}
                      onDrop={(event) => {
                        if (!entry.is_dir) return;
                        event.preventDefault();
                        event.stopPropagation();
                        event.currentTarget.classList.remove("bg-primary/20");
                        const data = readFileDragData(event.dataTransfer);
                        const paths = data?.paths.filter((path) => path !== entry.path) ?? [];
                        if (paths.length > 0) {
                          if (event.altKey) handleCopyTo(paths, entry.path);
                          else handleMove(paths, entry.path);
                        }
                      }}
                    >
                      <CompactFileThumbnail
                        entry={entry}
                        isInViewport={isInViewport}
                        isScrolling={virtualizer.isScrolling}
                      />
                      {editingPath === entry.path ? (
                        <Input
                          ref={renameInputRef}
                          value={editValue}
                          onChange={(event) => onEditValueChange(event.target.value)}
                          onBlur={onSubmitRename}
                          onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.key === "Enter") {
                              event.preventDefault();
                              onSubmitRename();
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              onCancelRename();
                            }
                          }}
                          onClick={(event) => event.stopPropagation()}
                          aria-label={`Rename ${entry.name}`}
                          className="h-6 min-w-0 flex-1 px-1 text-xs"
                        />
                      ) : (
                        <>
                          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                          <FinderTagDots tags={entry.tags} />
                        </>
                      )}
                      {entry.is_dir && (
                        <ChevronRight className="text-muted-foreground h-3 w-3 shrink-0" />
                      )}
                    </div>
                  </AppContextMenu>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={width}
        aria-valuemin={COLUMN_VIEW_WIDTH_MIN}
        aria-valuemax={COLUMN_VIEW_WIDTH_MAX}
        onPointerDown={handleResizePointerDown}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onAutoFitWidth(column.path, column.entries, event.altKey);
        }}
        className="group absolute inset-y-0 -right-1 z-20 flex w-2 cursor-col-resize items-center justify-center"
      >
        <div
          className={`h-full w-px transition-colors ${
            isResizing ? "bg-primary w-0.5" : "group-hover:bg-primary/60 bg-transparent"
          }`}
        />
      </div>
    </div>
  );
});

export function FileColumnView({
  currentPath,
  rootEntries,
  selectedPaths,
  focusedPath,
  selectedFileEntries,
  fileActions,
  editingPath,
  editValue,
  onEditValueChange,
  onSubmitRename,
  onCancelRename,
  onContextChange,
  navigationRef,
  onSelectSingle,
  onClick,
  onDoubleClick,
  onNavigate,
  handleMove,
  handleCopyTo,
  showHiddenFiles,
}: FileColumnViewProps) {
  const selectionRequests = useRef(new RequestGeneration());
  useEffect(() => {
    const requests = selectionRequests.current;
    requests.invalidate();
    return () => requests.invalidate();
  }, [currentPath, showHiddenFiles]);
  const columnViewWidth = useViewMode((state) => state.columnViewWidth);
  const setColumnViewWidth = useViewMode((state) => state.setColumnViewWidth);
  const [columnWidthOverrides, setColumnWidthOverrides] = useState<Record<string, number>>({});
  const [rawColumns, setColumns] = useState<ColumnData[]>(() =>
    rootEntries
      ? [
          {
            path: currentPath,
            entries: rootEntries,
            selectedPath:
              focusedPath && rootEntries.some((entry) => entry.path === focusedPath)
                ? focusedPath
                : null,
          },
        ]
      : []
  );
  const [activeColumnIndex, setActiveColumnIndex] = useState(0);

  // Derive root column synchronously from FileList's sortedEntries so switching
  // into Column View never flashes blank, respects current sort/filter, and
  // needs no cascading setState-in-effect.
  const columns = useMemo<ColumnData[]>(() => {
    if (!rootEntries) return rawColumns;
    if (rawColumns.length === 0 || rawColumns[0].path !== currentPath) {
      return [
        {
          path: currentPath,
          entries: rootEntries,
          selectedPath:
            focusedPath && rootEntries.some((entry) => entry.path === focusedPath)
              ? focusedPath
              : null,
        },
      ];
    }
    const rootSelected =
      rawColumns[0].selectedPath ??
      (focusedPath && rootEntries.some((entry) => entry.path === focusedPath) ? focusedPath : null);
    if (rawColumns[0].entries === rootEntries && rawColumns[0].selectedPath === rootSelected) {
      return rawColumns;
    }
    return [
      { ...rawColumns[0], entries: rootEntries, selectedPath: rootSelected },
      ...rawColumns.slice(1),
    ];
  }, [currentPath, focusedPath, rawColumns, rootEntries]);

  const effectiveActiveColumnIndex = Math.min(activeColumnIndex, Math.max(0, columns.length - 1));

  useEffect(() => {
    return () => {
      onContextChange(null);
    };
  }, [onContextChange]);

  const handleResizeColumnWidth = useCallback(
    (columnPath: string, width: number, applyAll: boolean) => {
      if (applyAll) {
        setColumnWidthOverrides({});
        setColumnViewWidth(width);
        return;
      }
      setColumnWidthOverrides((prev) => {
        if (!(columnPath in prev)) return prev;
        const next = { ...prev };
        delete next[columnPath];
        return next;
      });
      setColumnViewWidth(width);
    },
    [setColumnViewWidth]
  );

  const handleAutoFitColumnWidth = useCallback(
    (columnPath: string, entries: FileEntry[], applyAll: boolean) => {
      const idealWidth = computeColumnAutoFitWidth(entries);
      if (applyAll) {
        setColumnWidthOverrides({});
        setColumnViewWidth(idealWidth);
      } else {
        setColumnWidthOverrides((prev) => ({ ...prev, [columnPath]: idealWidth }));
      }
    },
    [setColumnViewWidth]
  );
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const refreshVersionsRef = useRef(new Map<string, number>());
  const showHiddenPreferenceRef = useRef(showHiddenFiles);
  const columnPathsKey = columns.map((column) => column.path).join("\0");
  const hasCurrentRoot = columns[0]?.path === currentPath;
  const selectedPathSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);

  const lastContextRef = useRef<{
    rootPath: string;
    locationPath: string;
    activeEntries: FileEntry[];
    columnEntriesSignature: FileEntry[][];
  } | null>(null);

  useEffect(() => {
    const activeColumn = columns[effectiveActiveColumnIndex];
    if (!activeColumn) {
      if (lastContextRef.current !== null) {
        lastContextRef.current = null;
        onContextChange(null);
      }
      return;
    }

    const locationPath = columns[columns.length - 1]?.path ?? currentPath;
    const prev = lastContextRef.current;
    const sameColumnsEntries =
      prev !== null &&
      prev.rootPath === currentPath &&
      prev.locationPath === locationPath &&
      prev.activeEntries === activeColumn.entries &&
      prev.columnEntriesSignature.length === columns.length &&
      prev.columnEntriesSignature.every((list, idx) => list === columns[idx]?.entries);
    if (sameColumnsEntries) return;

    lastContextRef.current = {
      rootPath: currentPath,
      locationPath,
      activeEntries: activeColumn.entries,
      columnEntriesSignature: columns.map((column) => column.entries),
    };

    onContextChange({
      rootPath: currentPath,
      locationPath,
      activeEntries: activeColumn.entries,
      visibleEntries: columns.flatMap((column) => column.entries),
    });
  }, [columns, currentPath, effectiveActiveColumnIndex, onContextChange]);

  useEffect(() => {
    if (!editingPath) return;
    const frame = requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [editingPath]);

  // 加载目录内容（使用与 Finder 一致的自然排序）
  const loadColumn = useCallback(async (path: string): Promise<FileEntry[]> => {
    try {
      const raw = await invoke<FileEntry[]>("get_entries", { path, forceRefresh: false });
      return sortFileEntries(raw, "name", "asc");
    } catch {
      return [];
    }
  }, []);

  // Listen before watching every visible column so external changes in child
  // directories cannot fall into the registration gap.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const registeredPaths: string[] = [];
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const visiblePaths = new Set([
      currentPath,
      ...(columnPathsKey ? columnPathsKey.split("\0") : []),
    ]);

    const setup = async () => {
      const stopListening = await listen<string>("dir-change", (event) => {
        const path = event.payload;
        if (!visiblePaths.has(path)) return;

        const requestId = (refreshVersionsRef.current.get(path) ?? 0) + 1;
        refreshVersionsRef.current.set(path, requestId);
        const existingTimer = timers.get(path);
        if (existingTimer) clearTimeout(existingTimer);

        timers.set(
          path,
          setTimeout(async () => {
            timers.delete(path);
            const entries = await loadColumn(path);
            if (cancelled || refreshVersionsRef.current.get(path) !== requestId) return;

            setColumns((current) => {
              const columnIndex = current.findIndex((column) => column.path === path);
              if (columnIndex < 0) return current;
              const next = current.slice();
              next[columnIndex] = {
                ...next[columnIndex],
                entries: filterHiddenEntries(entries, showHiddenFiles),
              };
              return next;
            });
            refreshVersionsRef.current.delete(path);
          }, DIR_CHANGE_DEBOUNCE_MS)
        );
      });

      if (cancelled) {
        stopListening();
        return;
      }
      unlisten = stopListening;

      const paths = new Set([currentPath, ...(columnPathsKey ? columnPathsKey.split("\0") : [])]);
      for (const path of paths) {
        try {
          await invoke("watch_directory", { path });
          if (cancelled) {
            invoke("unwatch_directory", { path }).catch(() => undefined);
            return;
          }
          registeredPaths.push(path);
        } catch {
          // A column can disappear while its watcher is being registered.
        }
      }

      // Start the first scan only after the listener and root watcher are in
      // place, so a change during enumeration cannot be missed.
      if (!hasCurrentRoot) {
        const entries = await loadColumn(currentPath);
        if (!cancelled) {
          setActiveColumnIndex(0);
          setColumns([
            {
              path: currentPath,
              entries: filterHiddenEntries(entries, showHiddenFiles),
              selectedPath: null,
            },
          ]);
        }
      }
    };

    void setup().catch((error) => {
      if (!cancelled) console.error("Failed to listen for directory changes:", error);
    });

    return () => {
      cancelled = true;
      unlisten?.();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const path of registeredPaths) {
        invoke("unwatch_directory", { path }).catch(() => undefined);
      }
    };
  }, [columnPathsKey, currentPath, hasCurrentRoot, loadColumn, showHiddenFiles]);

  useEffect(() => {
    if (showHiddenPreferenceRef.current === showHiddenFiles) return;
    showHiddenPreferenceRef.current = showHiddenFiles;

    let cancelled = false;
    const paths = [
      ...new Set([currentPath, ...(columnPathsKey ? columnPathsKey.split("\0") : [])]),
    ];
    const reloadColumns = async () => {
      const refreshed = await Promise.all(
        paths.map(async (path) => [path, await loadColumn(path)] as const)
      );
      if (cancelled) return;

      const entriesByPath = new Map(refreshed);
      setColumns((current) =>
        current.map((column) => {
          const entries = entriesByPath.get(column.path);
          return entries
            ? { ...column, entries: filterHiddenEntries(entries, showHiddenFiles) }
            : column;
        })
      );
    };

    void reloadColumns();
    return () => {
      cancelled = true;
    };
  }, [columnPathsKey, currentPath, loadColumn, showHiddenFiles]);

  const previewEntry = useMemo(() => {
    if (!hasCurrentRoot || !focusedPath || !selectedPathSet.has(focusedPath)) {
      return undefined;
    }
    for (const column of columns) {
      const match = column.entries.find((entry) => entry.path === focusedPath && !entry.is_dir);
      if (match) return match;
    }
    return undefined;
  }, [columns, focusedPath, hasCurrentRoot, selectedPathSet]);

  const isBrowsableDirectory = (entry: FileEntry) =>
    entry.is_dir && !(entry.is_package && entry.package_type === "app");

  const focusEntryInColumn = useCallback(
    async (columnIndex: number, entry: FileEntry) => {
      const requestId = selectionRequests.current.begin();
      let newEntries: FileEntry[] = [];
      const browsable = isBrowsableDirectory(entry);
      if (browsable) {
        newEntries = filterHiddenEntries(await loadColumn(entry.path), showHiddenFiles);
      }

      if (!selectionRequests.current.isCurrent(requestId)) return;
      setColumns((prev) => {
        const base = prev.length > 0 && prev[0].path === currentPath ? prev : columns;
        const current = base[columnIndex];
        if (!current) return base;
        if (!browsable && base.length === columnIndex + 1 && current.selectedPath === entry.path) {
          return prev;
        }
        const newColumns = base.slice(0, columnIndex + 1);
        newColumns[columnIndex] = { ...current, selectedPath: entry.path };
        if (browsable) {
          newColumns.push({ path: entry.path, entries: newEntries, selectedPath: null });
        }
        return newColumns;
      });

      if (browsable) {
        requestAnimationFrame(() => {
          scrollContainerRef.current?.scrollTo({
            left: scrollContainerRef.current.scrollWidth,
            behavior: "smooth",
          });
        });
      }
    },
    [columns, currentPath, loadColumn, showHiddenFiles]
  );

  // 选中文件夹时展开新列（使用函数式更新避免 columns 依赖）
  const handleSelect = useCallback(
    async (columnIndex: number, entry: FileEntry, entryIndex: number, e: React.MouseEvent) => {
      setActiveColumnIndex(columnIndex);
      onClick(entry, entryIndex, columns[columnIndex]?.entries ?? [], e);
      await focusEntryInColumn(columnIndex, entry);
    },
    [columns, focusEntryInColumn, onClick]
  );

  // 暴露分栏视图的键盘左右/上下导航能力
  useEffect(() => {
    if (!navigationRef) return;
    navigationRef.current = {
      navigateLeft: () => {
        if (effectiveActiveColumnIndex <= 0) return false;
        const parentIndex = effectiveActiveColumnIndex - 1;
        const parentColumn = columns[parentIndex];
        if (!parentColumn) return false;
        setActiveColumnIndex(parentIndex);
        const targetPath = parentColumn.selectedPath ?? parentColumn.entries[0]?.path;
        if (targetPath) {
          const entryIndex = parentColumn.entries.findIndex((entry) => entry.path === targetPath);
          if (entryIndex >= 0) {
            onSelectSingle(targetPath, entryIndex);
          }
        }
        return true;
      },
      navigateRight: async () => {
        const currentColumn = columns[effectiveActiveColumnIndex];
        if (!currentColumn) return false;
        const targetPath = focusedPath ?? currentColumn.selectedPath;
        const entry = currentColumn.entries.find((item) => item.path === targetPath);
        if (!entry || !isBrowsableDirectory(entry)) return false;

        const existingChild = columns[effectiveActiveColumnIndex + 1];
        let childEntries: FileEntry[];
        if (existingChild && existingChild.path === entry.path) {
          childEntries = existingChild.entries;
        } else {
          const requestId = selectionRequests.current.begin();
          childEntries = filterHiddenEntries(await loadColumn(entry.path), showHiddenFiles);
          if (!selectionRequests.current.isCurrent(requestId)) return false;
          setColumns((prev) => {
            const base = prev.length > 0 && prev[0].path === currentPath ? prev : columns;
            if (!base[effectiveActiveColumnIndex]) return base;
            const next = base.slice(0, effectiveActiveColumnIndex + 1);
            next[effectiveActiveColumnIndex] = {
              ...next[effectiveActiveColumnIndex],
              selectedPath: entry.path,
            };
            next.push({
              path: entry.path,
              entries: childEntries,
              selectedPath: childEntries[0]?.path ?? null,
            });
            return next;
          });
        }

        if (childEntries.length === 0) return true;

        const nextColIndex = effectiveActiveColumnIndex + 1;
        const firstChild = childEntries[0];
        setActiveColumnIndex(nextColIndex);
        onSelectSingle(firstChild.path, 0);
        setColumns((prev) => {
          const base = prev.length > 0 && prev[0].path === currentPath ? prev : columns;
          if (!base[nextColIndex]) return base;
          const next = base.slice(0, nextColIndex + 1);
          next[nextColIndex] = { ...next[nextColIndex], selectedPath: firstChild.path };
          return next;
        });

        requestAnimationFrame(() => {
          scrollContainerRef.current?.scrollTo({
            left: scrollContainerRef.current.scrollWidth,
            behavior: "smooth",
          });
        });
        return true;
      },
      focusEntry: async (entry: FileEntry) => {
        await focusEntryInColumn(effectiveActiveColumnIndex, entry);
      },
    };
    return () => {
      navigationRef.current = null;
    };
  }, [
    columns,
    currentPath,
    effectiveActiveColumnIndex,
    focusEntryInColumn,
    focusedPath,
    loadColumn,
    navigationRef,
    onSelectSingle,
    showHiddenFiles,
  ]);

  // 双击文件夹时导航
  const handleDoubleClick = useCallback(
    (entry: FileEntry) => {
      if (entry.is_dir) {
        onNavigate(entry.path);
      } else {
        onDoubleClick(entry);
      }
    },
    [onNavigate, onDoubleClick]
  );

  return (
    <div ref={scrollContainerRef} className="flex h-full overflow-x-auto overflow-y-hidden">
      {columns.map((column, colIdx) => (
        <ColumnPane
          key={column.path}
          column={column}
          colIdx={colIdx}
          width={columnWidthOverrides[column.path] ?? columnViewWidth}
          onResizeWidth={handleResizeColumnWidth}
          onAutoFitWidth={handleAutoFitColumnWidth}
          selectedPaths={selectedPaths}
          selectedPathSet={selectedPathSet}
          focusedPath={focusedPath}
          selectedFileEntries={selectedFileEntries}
          fileActions={fileActions}
          editingPath={editingPath}
          editValue={editValue}
          renameInputRef={renameInputRef}
          onEditValueChange={onEditValueChange}
          onSubmitRename={onSubmitRename}
          onCancelRename={onCancelRename}
          onSelect={handleSelect}
          onDoubleClick={handleDoubleClick}
          handleMove={handleMove}
          handleCopyTo={handleCopyTo}
        />
      ))}
      {previewEntry && (
        <ColumnFilePreview
          key={previewEntry.path}
          entry={previewEntry}
          onDoubleClick={handleDoubleClick}
        />
      )}
    </div>
  );
}

import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DIR_CHANGE_DEBOUNCE_MS } from "@/constants/config";
import { Folder, File, ChevronRight } from "lucide-react";
import { FileEntry } from "@/types";
import { SmartIcon } from "@/components/SmartIcon";
import { filterHiddenEntries } from "@/utils/file";
import { readFileDragData } from "@/lib/dragData";
import { makeNativeFileDragGestureHandlers } from "@/lib/nativeFileDragGesture";
import { AppContextMenu } from "@/components/AppContextMenu";
import { Input } from "@/components/ui/input";
import type { FileActions } from "@/types";

export interface ColumnSelectionContext {
  rootPath: string;
  locationPath: string;
  activeEntries: FileEntry[];
  visibleEntries: FileEntry[];
}

interface FileColumnViewProps {
  currentPath: string;
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
  onClick: (entry: FileEntry, index: number, columnEntries: FileEntry[], e: React.MouseEvent) => void;
  onDoubleClick: (entry: FileEntry) => void;
  onNavigate: (path: string) => void;
  handleMove: (src: string, dest: string) => void;
  showHiddenFiles: boolean;
}

interface ColumnData {
  path: string;
  entries: FileEntry[];
  selectedPath: string | null;
}

export function FileColumnView({
  currentPath,
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
  onClick,
  onDoubleClick,
  onNavigate,
  handleMove,
  showHiddenFiles,
}: FileColumnViewProps) {
  const [columns, setColumns] = useState<ColumnData[]>([]);
  const [activeColumnIndex, setActiveColumnIndex] = useState(0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const refreshVersionsRef = useRef(new Map<string, number>());
  const showHiddenPreferenceRef = useRef(showHiddenFiles);
  const columnPathsKey = columns.map((column) => column.path).join("\0");
  const hasCurrentRoot = columns[0]?.path === currentPath;

  useEffect(() => {
    const activeColumn = columns[activeColumnIndex];
    if (!activeColumn) {
      onContextChange(null);
      return;
    }

    onContextChange({
      rootPath: currentPath,
      locationPath: columns[columns.length - 1]?.path ?? currentPath,
      activeEntries: activeColumn.entries,
      visibleEntries: columns.flatMap((column) => column.entries),
    });
  }, [activeColumnIndex, columns, currentPath, onContextChange]);

  useEffect(() => {
    if (!editingPath) return;
    const frame = requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [editingPath]);

  // 加载目录内容
  const loadColumn = useCallback(async (path: string): Promise<FileEntry[]> => {
    try {
      return await invoke<FileEntry[]>("get_entries", { path, forceRefresh: false });
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

  // 选中文件夹时展开新列（使用函数式更新避免 columns 依赖）
  const handleSelect = useCallback(
    async (columnIndex: number, entry: FileEntry, entryIndex: number, e: React.MouseEvent) => {
      setActiveColumnIndex(columnIndex);
      onClick(entry, entryIndex, columns[columnIndex]?.entries ?? [], e);

      let newEntries: FileEntry[] = [];
      if (entry.is_dir) {
        newEntries = filterHiddenEntries(await loadColumn(entry.path), showHiddenFiles);
      }

      setColumns((prev) => {
        const newColumns = prev.slice(0, columnIndex + 1);
        newColumns[columnIndex] = { ...newColumns[columnIndex], selectedPath: entry.path };
        if (entry.is_dir) {
          newColumns.push({ path: entry.path, entries: newEntries, selectedPath: null });
        }
        return newColumns;
      });

      // 自动滚动到最右侧
      requestAnimationFrame(() => {
        scrollContainerRef.current?.scrollTo({
          left: scrollContainerRef.current.scrollWidth,
          behavior: "smooth",
        });
      });
    },
    [columns, loadColumn, onClick, showHiddenFiles]
  );

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
        <div
          key={column.path}
          className="border-border/30 flex h-full w-60 shrink-0 flex-col border-r last:border-r-0"
        >
          <div className="flex-1 overflow-y-auto">
            {column.entries.map((entry, entryIdx) => {
              const isSelected = selectedPaths.includes(entry.path);
              const isColumnSelected = column.selectedPath === entry.path;
              const dragPaths = isSelected ? selectedPaths : [entry.path];
              const nativeDragHandlers = makeNativeFileDragGestureHandlers(dragPaths);
              return (
                <AppContextMenu
                  key={entry.path}
                  type={entry.is_dir ? "folder" : "file"}
                  entry={entry}
                  selectedEntries={selectedFileEntries}
                  fileActions={fileActions}
                >
                  <div
                    {...nativeDragHandlers}
                    className={`flex cursor-default items-center gap-2 px-2 py-1.5 text-sm transition-colors ${
                      isSelected || isColumnSelected ? "bg-accent" : "hover:bg-accent/50"
                    } ${focusedPath === entry.path ? "outline-primary outline outline-1 outline-offset-[-1px]" : ""}`}
                    onClick={(e) => handleSelect(colIdx, entry, entryIdx, e)}
                    onDoubleClick={() => handleDoubleClick(entry)}
                    onDragOver={(event) => {
                      if (!entry.is_dir) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "copy";
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
                      data?.paths
                        .filter((path) => path !== entry.path)
                        .forEach((path) => handleMove(path, entry.path));
                    }}
                  >
                    <SmartIcon
                      icon={entry.is_dir ? Folder : File}
                      className={
                        entry.is_dir
                          ? "h-4 w-4 shrink-0 text-blue-500"
                          : "text-muted-foreground h-4 w-4 shrink-0"
                      }
                      sysIcon={
                        entry.is_dir
                          ? { type: "folder" }
                          : { type: "ext", value: entry.extension || "" }
                      }
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
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                    )}
                    {entry.is_dir && (
                      <ChevronRight className="text-muted-foreground h-3 w-3 shrink-0" />
                    )}
                  </div>
                </AppContextMenu>
              );
            })}
            {column.entries.length === 0 && (
              <div className="text-muted-foreground flex h-20 items-center justify-center text-xs">
                Empty
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

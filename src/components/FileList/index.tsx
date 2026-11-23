import { useEffect, useMemo, useRef, useCallback, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AppContextMenu } from "@/components/AppContextMenu";
import { FileEntry, FileActions } from "@/types";
import { useViewMode } from "@/stores/viewMode";
import { useTabs } from "@/hooks/useTabs";
import { useSetting } from "@/hooks/useSetting";
import { QuickLook } from "@/components/QuickLook";
import { SMART_FOLDER_PREFIX } from "@/constants/config";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentKeyboardCommandScope } from "@/lib/keyboardShortcuts";
import { isRegisteredCommandEnabled } from "@/lib/commands";
import { useFileSort } from "./hooks/useFileSort";
import { useFileSelection } from "./hooks/useFileSelection";
import { useFileOperations } from "./hooks/useFileOperations";
import { useFileKeyboardShortcuts } from "./hooks/useFileKeyboardShortcuts";
import { useFileEntries } from "./hooks/useFileEntries";
import { useFileRename } from "./hooks/useFileRename";
import { useMarqueeSelection } from "./hooks/useMarqueeSelection";
import { useQuickLook } from "./hooks/useQuickLook";
import { usePhotoAnalysis } from "@/hooks/usePhotoAnalysis";
import { FolderSharpnessPanel } from "@/components/FolderSharpnessPanel";
import { useVisibleSharpness } from "@/hooks/useVisibleSharpness";
import { getPhotoGroupColor } from "@/lib/photoAnalysis";
import { hydratePhotoMetadataCache } from "@/lib/photoMetadata";
import { FileListHeader } from "./components/FileListHeader";
import { FileListItem } from "./components/FileListItem";
import { FileGridItem } from "./components/FileGridItem";
import { FileGalleryView } from "./components/FileGalleryView";
import {
  FileColumnView,
  type ColumnNavigationHandle,
  type ColumnSelectionContext,
} from "./components/FileColumnView";
import { BatchRenameDialog } from "@/components/BatchRenameDialog";
import { readFileDragData } from "@/lib/dragData";
import { makeNativeFileDragGestureHandlers } from "@/lib/nativeFileDragGesture";
import { isPermissionDeniedError, requestDirectoryAccess } from "@/lib/directoryAccess";
import { settingsManager } from "@/lib/store";
import { useStatusBar } from "@/stores/statusBar";

/** 列表视图固定行高 */
const LIST_ITEM_HEIGHT = 32;
/** 文件夹行保持 Finder 式紧凑间距 */
const GRID_ROW_HEIGHT = 116;
/** 网格项最小宽度 */
const GRID_ITEM_MIN_WIDTH = 132;
/** 网格间距 */
const GRID_GAP = 12;

interface FileListProps {
  currentPath: string;
  onNavigate: (path: string, selectFile?: string) => void;
  fileToSelect?: string | null;
}

/** 拖拽事件处理工厂（按住 Option / Alt 键执行复制而非移动） */
function makeDragHandlers(
  entry: FileEntry,
  selectedPaths: string[],
  handleMove: (src: string | string[], dest: string) => void,
  handleCopyTo: (src: string | string[], dest: string) => void,
  isGrid: boolean
) {
  const dragPaths = selectedPaths.includes(entry.path) ? selectedPaths : [entry.path];

  return {
    ...makeNativeFileDragGestureHandlers(dragPaths),
    onDragOver: (e: React.DragEvent) => {
      if (!entry.is_dir) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
      if (isGrid) {
        e.currentTarget.querySelector(".group")?.classList.add("bg-primary/20", "rounded-lg");
      } else {
        e.currentTarget.classList.add("bg-primary/20", "rounded-md");
      }
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!entry.is_dir) return;
      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
        if (isGrid) {
          e.currentTarget.querySelector(".group")?.classList.remove("bg-primary/20", "rounded-lg");
        } else {
          e.currentTarget.classList.remove("bg-primary/20", "rounded-md");
        }
      }
    },
    onDrop: (e: React.DragEvent) => {
      if (!entry.is_dir) return;
      e.preventDefault();
      e.stopPropagation();
      if (isGrid) {
        e.currentTarget.querySelector(".group")?.classList.remove("bg-primary/20", "rounded-lg");
      } else {
        e.currentTarget.classList.remove("bg-primary/20", "rounded-md");
      }
      const data = readFileDragData(e.dataTransfer);
      if (data) {
        const paths = data.paths.filter((path) => path !== entry.path);
        if (paths.length > 0) {
          if (e.altKey) handleCopyTo(paths, entry.path);
          else handleMove(paths, entry.path);
        }
      }
    },
  };
}

export function FileList({ currentPath, onNavigate, fileToSelect }: FileListProps) {
  const { t } = useTranslation();
  const { viewMode, iconSize, listColumnWidths, listColumnVisibility } = useViewMode();
  // Photo details and analysis are available automatically in every view.
  const photoAnalysisEnabled = true;
  const { addTab, activeTab, goBack, goForward, canGoBack, canGoForward } = useTabs();
  const setStatusBar = useStatusBar((state) => state.setStatus);
  const [legacyTabNumberShortcuts] = useSetting<boolean>("legacy_cmd_number_tabs", false);
  const [gridColumns, setGridColumns] = useState(6);
  const [columnSelectionContext, setColumnSelectionContext] =
    useState<ColumnSelectionContext | null>(null);
  const columnNavRef = useRef<ColumnNavigationHandle | null>(null);

  // 1. 数据加载
  const { entries, showHiddenFiles, loading, error, loadEntries } = useFileEntries(currentPath);
  const [requestingAccess, setRequestingAccess] = useState(false);

  // Batch-hydrate EXIF shooting parameters from SQLite once per directory load.
  useEffect(() => {
    if (!loading && !error && entries.length > 0) {
      void hydratePhotoMetadataCache(entries);
    }
  }, [entries, error, loading]);

  // 2. 排序
  const { sortField, sortDirection, handleSort, handleArrange, sortedEntries } =
    useFileSort(entries);
  const activeColumnContext =
    viewMode === "column" && columnSelectionContext?.rootPath === currentPath
      ? columnSelectionContext
      : null;
  const selectionEntries = useMemo(
    () =>
      activeColumnContext
        ? Array.from(
            new Map(
              [...sortedEntries, ...activeColumnContext.visibleEntries].map((entry) => [
                entry.path,
                entry,
              ])
            ).values()
          )
        : sortedEntries,
    [activeColumnContext, sortedEntries]
  );
  const keyboardEntries = activeColumnContext?.activeEntries ?? sortedEntries;
  const operationPath = activeColumnContext?.locationPath ?? currentPath;
  const canMutate = !loading && !error && !operationPath.startsWith(SMART_FOLDER_PREFIX);

  // 3. 选择状态
  const {
    selectedPath,
    selectedPaths,
    setSelectedPath,
    selectSingle,
    toggleSelection,
    selectRange,
    selectAll,
    selectPaths,
    clearSelection,
    editingPath,
    setEditingPath,
    editValue,
    setEditValue,
  } = useFileSelection(selectionEntries);

  useEffect(() => {
    if (
      (viewMode === "column" || viewMode === "gallery") &&
      !loading &&
      !selectedPath &&
      !fileToSelect &&
      sortedEntries.length
    ) {
      setSelectedPath(sortedEntries[0].path);
    }
  }, [viewMode, loading, selectedPath, fileToSelect, sortedEntries, setSelectedPath]);

  // 4. 重命名
  const { handleStartRename, handleSubmitRename, handleCancelRename } = useFileRename({
    entries: selectionEntries,
    editingPath,
    editValue,
    setEditingPath,
    setEditValue,
    setSelectedPath,
    onRefresh: () => loadEntries(false),
  });

  // 5. 文件操作
  const {
    handleOpen,
    handleCopy,
    handleCut,
    handlePaste,
    handleDuplicate,
    handleDelete,
    handleCompress,
    handleExtract,
    handleGetInfo,
    handleToggleFavorite,
    isFavorite,
    handleCopyPath,
    handleNewFile,
    handleNewFolder,
    handlePasteAsMove,
    handleOpenInTerminal,
    handleShowPackageContents,
    handleShowOriginal,
    handleToggleTag,
    handleCopyTo,
    handleMove,
  } = useFileOperations({
    currentPath: operationPath,
    onRefresh: (forceRefresh = false) => loadEntries(false, forceRefresh),
    onNavigate,
    onStartRename: (path: string, name: string) => {
      setSelectedPath(path);
      setEditingPath(path);
      setEditValue(name);
    },
  });

  // 6. 批量重命名
  const [batchRenameFiles, setBatchRenameFiles] = useState<FileEntry[]>([]);
  const [showBatchRename, setShowBatchRename] = useState(false);
  const [isFileDragOver, setIsFileDragOver] = useState(false);

  // 7. 快速预览
  const { quickLookEntry, setQuickLookEntry, useNativeQuickLook } = useQuickLook({
    selectedPath,
    editingPath,
    entries: keyboardEntries,
    forceCustomImagePreview: viewMode === "icon" && photoAnalysisEnabled,
  });

  const scrollToIndexRef = useRef<(index: number) => void>(() => undefined);

  const handleOpenParent = useCallback(() => {
    if (!currentPath || currentPath === "/" || currentPath.startsWith(SMART_FOLDER_PREFIX)) return;
    const trimmed = currentPath.replace(/\/+$/, "");
    const slashIndex = trimmed.lastIndexOf("/");
    const parentPath = slashIndex <= 0 ? "/" : trimmed.slice(0, slashIndex);
    if (parentPath !== currentPath) {
      onNavigate(parentPath, trimmed);
    }
  }, [currentPath, onNavigate]);

  const handleToggleHiddenFiles = useCallback(() => {
    void settingsManager.set("show_hidden_files", !showHiddenFiles);
  }, [showHiddenFiles]);

  // 7. 键盘快捷键
  const fileCommands = useFileKeyboardShortcuts({
    selectedPath,
    selectedPaths,
    editingPath,
    sortedEntries: keyboardEntries,
    entries: selectionEntries,
    viewMode,
    gridColumns,
    canMutate,
    legacyTabNumberShortcuts,
    openEntry: handleOpen,
    onOpenParent: handleOpenParent,
    onGoBack: goBack,
    onGoForward: goForward,
    canGoBack,
    canGoForward,
    onToggleHiddenFiles: handleToggleHiddenFiles,
    onScrollToIndex: (index) => scrollToIndexRef.current(index),
    onColumnNavigateLeft: () => columnNavRef.current?.navigateLeft() ?? false,
    onColumnNavigateRight: () => columnNavRef.current?.navigateRight() ?? Promise.resolve(false),
    onColumnFocusEntry: (entry) => columnNavRef.current?.focusEntry(entry) ?? Promise.resolve(),
    selectAll,
    selectSingle,
    selectRange,
    clearSelection,
    handleCopy,
    handleCut,
    handlePaste,
    handlePasteAsMove,
    handleDuplicate,
    handleGetInfo,
    handleDelete,
    handleNewFile,
    handleNewFolder,
    handleRename: handleStartRename,
  });

  const editCutEnabled = isRegisteredCommandEnabled("edit.cut");
  const editCopyEnabled = isRegisteredCommandEnabled("edit.copy");
  const editPasteEnabled = isRegisteredCommandEnabled("edit.paste");
  const editSelectAllEnabled = isRegisteredCommandEnabled("edit.select-all");

  const lastSyncedMenuRef = useRef<Map<string, boolean>>(new Map());

  useEffect(() => {
    if (activeTab?.path !== currentPath) return;

    const currentWindow = getCurrentWindow();
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let syncTimer: ReturnType<typeof setTimeout> | null = null;
    const syncNativeMenu = async (force = false) => {
      try {
        if (cancelled || !(await currentWindow.isFocused())) return;
        const scope = getCurrentKeyboardCommandScope();
        const fileViewEnabled = scope === "file-view";
        const commandStates: Array<[string, boolean]> = [
          ["window.new", scope === "file-view"],
          ["file.new-file", fileViewEnabled && isRegisteredCommandEnabled("file.new-file")],
          ["file.new-folder", fileViewEnabled && isRegisteredCommandEnabled("file.new-folder")],
          ["edit.cut", isRegisteredCommandEnabled("edit.cut")],
          ["edit.copy", isRegisteredCommandEnabled("edit.copy")],
          ["edit.paste", isRegisteredCommandEnabled("edit.paste")],
          ["edit.select-all", isRegisteredCommandEnabled("edit.select-all")],
        ];
        const changedStates = force
          ? commandStates
          : commandStates.filter(
              ([commandId, enabled]) => lastSyncedMenuRef.current.get(commandId) !== enabled
            );
        if (changedStates.length === 0) return;

        await invoke("set_native_menu_commands_enabled", { states: changedStates });
        if (!cancelled) {
          for (const [commandId, enabled] of changedStates) {
            lastSyncedMenuRef.current.set(commandId, enabled);
          }
        }
      } catch (syncError) {
        console.error("Failed to sync native file menu state:", syncError);
      }
    };
    const queueMenuSync = () => {
      if (syncTimer !== null) return;
      syncTimer = setTimeout(() => {
        syncTimer = null;
        void syncNativeMenu();
      }, 32);
    };

    void syncNativeMenu();
    document.addEventListener("focusin", queueMenuSync);
    document.addEventListener("focusout", queueMenuSync);
    document.addEventListener("selectionchange", queueMenuSync);
    document.addEventListener("keyup", queueMenuSync);
    document.addEventListener("mouseup", queueMenuSync);
    document.addEventListener("input", queueMenuSync);
    window.addEventListener("app-command-registry-changed", queueMenuSync);
    void currentWindow
      .onFocusChanged(({ payload: focused }) => {
        if (focused) {
          lastSyncedMenuRef.current.clear();
          void syncNativeMenu(true);
        }
      })
      .then((dispose) => {
        if (cancelled) {
          dispose();
        } else {
          unlisten = dispose;
        }
      })
      .catch((syncError) => console.error("Failed to watch window focus:", syncError));

    return () => {
      cancelled = true;
      if (syncTimer !== null) clearTimeout(syncTimer);
      unlisten?.();
      document.removeEventListener("focusin", queueMenuSync);
      document.removeEventListener("focusout", queueMenuSync);
      document.removeEventListener("selectionchange", queueMenuSync);
      document.removeEventListener("keyup", queueMenuSync);
      document.removeEventListener("mouseup", queueMenuSync);
      document.removeEventListener("input", queueMenuSync);
      window.removeEventListener("app-command-registry-changed", queueMenuSync);
    };
  }, [
    activeTab?.path,
    canMutate,
    currentPath,
    editingPath,
    keyboardEntries.length,
    editCopyEnabled,
    editCutEnabled,
    editPasteEnabled,
    editSelectAllEnabled,
    selectedPath,
    selectedPaths,
  ]);

  // === 虚拟滚动 ===
  const listScrollRef = useRef<HTMLDivElement>(null);
  const gridScrollRef = useRef<HTMLDivElement>(null);
  const scrollPositionsRef = useRef<Record<string, number>>({});

  const getScrollContainer = useCallback((mode: typeof viewMode) => {
    if (mode === "list") return listScrollRef.current;
    if (mode === "icon") return gridScrollRef.current;
    return null;
  }, []);

  const gridItemWidth = Math.max(GRID_ITEM_MIN_WIDTH, iconSize + 16);
  const photoGridRowHeight = Math.max(212, iconSize + 104);
  const folderGridRowHeight = Math.max(GRID_ROW_HEIGHT, Math.round(iconSize * 0.65) + 42);

  // 计算网格每行列数
  const updateGridColumns = useCallback(() => {
    const el = gridScrollRef.current;
    if (!el) return;
    const containerWidth = el.clientWidth - 16; // p-2 padding
    const nextColumns = Math.max(
      1,
      Math.floor((containerWidth + GRID_GAP) / (gridItemWidth + GRID_GAP))
    );
    setGridColumns((current) => (current === nextColumns ? current : nextColumns));
  }, [gridItemWidth]);

  useEffect(() => {
    updateGridColumns();
    const el = gridScrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(updateGridColumns);
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateGridColumns, viewMode]);

  // 网格行数
  const gridRowCount = useMemo(
    () => Math.ceil(sortedEntries.length / gridColumns),
    [gridColumns, sortedEntries.length]
  );

  // 列表虚拟化
  const listVirtualizer = useVirtualizer({
    count: sortedEntries.length,
    getScrollElement: () => listScrollRef.current,
    estimateSize: () => LIST_ITEM_HEIGHT,
    overscan: 6,
    useAnimationFrameWithResizeObserver: true,
  });

  // 网格虚拟化（按行）
  const gridVirtualizer = useVirtualizer({
    count: gridRowCount,
    getScrollElement: () => gridScrollRef.current,
    estimateSize: (rowIndex) => {
      if (!photoAnalysisEnabled) return folderGridRowHeight;
      const start = rowIndex * gridColumns;
      const end = Math.min(sortedEntries.length, start + gridColumns);
      for (let i = start; i < end; i += 1) {
        if (!sortedEntries[i].is_dir) return photoGridRowHeight;
      }
      return folderGridRowHeight;
    },
    overscan: 2,
    useAnimationFrameWithResizeObserver: true,
  });
  useEffect(() => {
    gridVirtualizer.measure();
  }, [
    folderGridRowHeight,
    gridColumns,
    photoAnalysisEnabled,
    photoGridRowHeight,
    sortedEntries,
    gridVirtualizer,
  ]);

  const { marqueeRect: listMarqueeRect, handleMarqueeMouseDown: handleListMarqueeMouseDown } =
    useMarqueeSelection({
      containerRef: listScrollRef,
      enabled: viewMode === "list" && !editingPath,
      selectedPaths,
      onSelectPaths: selectPaths,
      onClearSelection: clearSelection,
    });

  const { marqueeRect: gridMarqueeRect, handleMarqueeMouseDown: handleGridMarqueeMouseDown } =
    useMarqueeSelection({
      containerRef: gridScrollRef,
      enabled: viewMode === "icon" && !editingPath,
      selectedPaths,
      onSelectPaths: selectPaths,
      onClearSelection: clearSelection,
    });
  const gridIsScrolling = viewMode === "icon" && gridVirtualizer.isScrolling;
  const gridViewportStartRow = gridVirtualizer.range?.startIndex ?? null;
  const gridViewportEndRow = gridVirtualizer.range?.endIndex ?? null;
  const gridViewportEntries = useMemo(() => {
    if (viewMode !== "icon" || gridViewportStartRow === null || gridViewportEndRow === null) {
      return [];
    }

    const startIndex = gridViewportStartRow * gridColumns;
    const endIndex = Math.min(sortedEntries.length, (gridViewportEndRow + 1) * gridColumns);
    return sortedEntries.slice(startIndex, endIndex);
  }, [gridColumns, gridViewportEndRow, gridViewportStartRow, sortedEntries, viewMode]);
  const gridViewportPaths = useMemo(
    () => gridViewportEntries.map((entry) => entry.path),
    [gridViewportEntries]
  );
  const gridViewportPathSet = useMemo(() => new Set(gridViewportPaths), [gridViewportPaths]);
  const listStart = listVirtualizer.range?.startIndex ?? 0;
  const listEnd = listVirtualizer.range?.endIndex ?? -1;
  const listViewportPaths = useMemo(() => {
    if (viewMode !== "list" || listEnd < listStart) return [];
    return sortedEntries.slice(listStart, listEnd + 1).map((entry) => entry.path);
  }, [listEnd, listStart, sortedEntries, viewMode]);
  const viewportPriorityPaths = viewMode === "icon" ? gridViewportPaths : listViewportPaths;
  const folderScanEntries = useMemo(
    () =>
      entries.filter(
        (entry) =>
          currentPath.startsWith(SMART_FOLDER_PREFIX) ||
          (entry.path.slice(0, entry.path.lastIndexOf("/")) || "/") === currentPath
      ),
    [entries, currentPath]
  );
  const visibleSharpness = useVisibleSharpness(
    folderScanEntries,
    !loading && !error && !quickLookEntry,
    viewportPriorityPaths
  );

  const photoAnalysisEnabledForFolder = photoAnalysisEnabled;
  const { records: photoAnalysis } = usePhotoAnalysis(
    entries,
    photoAnalysisEnabledForFolder,
    currentPath,
    viewportPriorityPaths,
    Boolean(quickLookEntry)
  );

  useEffect(() => {
    const locationKey = `${viewMode}:${currentPath}`;
    const scrollPositions = scrollPositionsRef.current;
    const scrollContainer = getScrollContainer(viewMode);
    return () => {
      if (scrollContainer) {
        scrollPositions[locationKey] = scrollContainer.scrollTop;
      }
    };
  }, [currentPath, getScrollContainer, viewMode]);

  const restoredViewRef = useRef<string | null>(null);
  useEffect(() => {
    const locationKey = `${viewMode}:${currentPath}`;
    if (loading || restoredViewRef.current === locationKey) return;
    if (viewMode === "column" || viewMode === "gallery") {
      restoredViewRef.current = locationKey;
      return;
    }
    // Wait until the new scroll element and grid width have been measured.
    // A saved offset belongs to the old view; the shared selection takes priority.
    let secondFrame = 0;
    const frame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        const container = getScrollContainer(viewMode);
        if (!container) return;
        const index = sortedEntries.findIndex((entry) => entry.path === selectedPath);
        if (index >= 0) {
          if (viewMode === "list") {
            listVirtualizer.scrollToIndex(index, { align: "center" });
          } else {
            gridVirtualizer.scrollToIndex(Math.floor(index / gridColumns), { align: "center" });
          }
        } else {
          container.scrollTop = scrollPositionsRef.current[locationKey] ?? 0;
        }
        restoredViewRef.current = locationKey;
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(secondFrame);
    };
  }, [
    currentPath,
    getScrollContainer,
    loading,
    viewMode,
    selectedPath,
    sortedEntries,
    gridColumns,
    listVirtualizer,
    gridVirtualizer,
  ]);

  // 8. 自动选中和滚动
  const appliedFileSelection = useRef<string | null>(null);
  useEffect(() => {
    const requestKey = fileToSelect ? `${currentPath}:${fileToSelect}` : null;
    if (!requestKey) appliedFileSelection.current = null;
    if (fileToSelect && entries.length > 0 && appliedFileSelection.current !== requestKey) {
      const entry = entries.find((e) => e.path === fileToSelect);
      if (entry) {
        appliedFileSelection.current = requestKey;
        setSelectedPath(entry.path);
        const idx = sortedEntries.findIndex((e) => e.path === fileToSelect);
        if (idx >= 0) {
          if (viewMode === "list") {
            listVirtualizer.scrollToIndex(idx, { align: "center" });
          } else {
            const rowIdx = Math.floor(idx / gridColumns);
            gridVirtualizer.scrollToIndex(rowIdx, { align: "center" });
          }
        }
      }
    }
  }, [
    currentPath,
    entries,
    fileToSelect,
    gridColumns,
    setSelectedPath,
    sortedEntries,
    viewMode,
    listVirtualizer,
    gridVirtualizer,
  ]);

  // 当前选中的文件集合与列表（O(N) 而非 O(N*M)）
  const selectedPathSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const selectedFileEntries = useMemo(
    () => selectionEntries.filter((e) => selectedPathSet.has(e.path)),
    [selectionEntries, selectedPathSet]
  );

  useEffect(() => {
    scrollToIndexRef.current = (index: number) => {
      if (index < 0) return;
      if (viewMode === "list") {
        listVirtualizer.scrollToIndex(index, { align: "auto" });
      } else if (viewMode === "icon") {
        gridVirtualizer.scrollToIndex(Math.floor(index / gridColumns), { align: "auto" });
      }
    };
  }, [gridColumns, gridVirtualizer, listVirtualizer, viewMode]);

  useEffect(() => {
    let selectedBytes = 0;
    for (const entry of selectedFileEntries) {
      if (!entry.is_dir && entry.size > 0) {
        selectedBytes += entry.size;
      }
    }
    setStatusBar({
      path: currentPath,
      totalCount: keyboardEntries.length,
      selectedCount: selectedFileEntries.length,
      selectedBytes,
      loading,
    });
  }, [currentPath, keyboardEntries.length, loading, selectedFileEntries, setStatusBar]);

  const sortedEntriesRef = useRef(sortedEntries);
  const selectedPathSetRef = useRef(selectedPathSet);
  useEffect(() => {
    sortedEntriesRef.current = sortedEntries;
  }, [sortedEntries]);
  useEffect(() => {
    selectedPathSetRef.current = selectedPathSet;
  }, [selectedPathSet]);

  // 点击处理（稳定引用，避免破坏 FileListItem / FileGridItem 的 React.memo）
  const handleClick = useCallback(
    (
      entry: FileEntry,
      index: number,
      e: React.MouseEvent,
      sourceEntries: FileEntry[] = sortedEntriesRef.current
    ) => {
      if (e.metaKey || e.ctrlKey) {
        toggleSelection(entry.path, index);
      } else if (e.shiftKey) {
        selectRange(sourceEntries, index);
      } else {
        selectSingle(entry.path, index);
      }
    },
    [selectRange, selectSingle, toggleSelection]
  );

  // Finder 风格：点击未选中的文件名先选中，点击已选中文件名进入重命名。
  const handleNameClick = useCallback(
    (entry: FileEntry, index: number, e: React.MouseEvent) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) {
        handleClick(entry, index, e);
        return;
      }

      if (selectedPathSetRef.current.has(entry.path) && !entry.readonly) {
        handleStartRename(entry);
      } else {
        selectSingle(entry.path, index);
      }
    },
    [handleClick, handleStartRename, selectSingle]
  );

  // 跳转到位置
  const handleGoToLocation = useCallback(
    async (entry: FileEntry) => {
      try {
        const parentDir = await invoke<string>("get_parent_dir", { path: entry.path });
        if (parentDir) {
          onNavigate(parentDir, entry.path);
        }
      } catch (e) {
        console.error("Failed to go to location:", e);
      }
    },
    [onNavigate]
  );

  const handleFileContainerDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (e.defaultPrevented) {
        setIsFileDragOver(false);
        return;
      }
      if (operationPath.startsWith(SMART_FOLDER_PREFIX)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
      setIsFileDragOver(true);
    },
    [operationPath]
  );

  const handleFileContainerDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsFileDragOver(false);
    }
  }, []);

  const handleFileContainerDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (operationPath.startsWith(SMART_FOLDER_PREFIX)) return;
      const data = readFileDragData(e.dataTransfer);
      if (!data) return;

      e.preventDefault();
      e.stopPropagation();
      setIsFileDragOver(false);
      const paths = data.paths.filter((path) => path !== operationPath);
      if (paths.length > 0) {
        if (e.altKey) handleCopyTo(paths, operationPath);
        else handleMove(paths, operationPath);
      }
    },
    [operationPath, handleCopyTo, handleMove]
  );

  // 文件操作对象
  const fileActions: FileActions = useMemo(
    () => ({
      onOpen: handleOpen,
      onOpenInNewTab: (entry) => {
        if (entry.is_dir) addTab(entry.path);
      },
      onShowPackageContents: handleShowPackageContents,
      onShowOriginal: handleShowOriginal,
      onToggleTag: handleToggleTag,
      onCopy: handleCopy,
      onCut: handleCut,
      onPaste: handlePaste,
      onDuplicate: handleDuplicate,
      onCopyPath: handleCopyPath,
      onDelete: handleDelete,
      onCompress: handleCompress,
      onExtract: handleExtract,
      onGetInfo: handleGetInfo,
      onToggleFavorite: handleToggleFavorite,
      isFavorite,
      onRename: handleStartRename,
      onGoToLocation: currentPath.startsWith(SMART_FOLDER_PREFIX) ? handleGoToLocation : undefined,
      onBatchRename: (entries: FileEntry[]) => {
        setBatchRenameFiles(entries);
        setShowBatchRename(true);
      },
      commands: fileCommands,
      currentPath: operationPath,
    }),
    [
      addTab,
      currentPath,
      fileCommands,
      handleCompress,
      handleCopy,
      handleCopyPath,
      handleCut,
      handleDelete,
      handleDuplicate,
      handleExtract,
      handleGetInfo,
      handleGoToLocation,
      handleOpen,
      handlePaste,
      handleShowOriginal,
      handleShowPackageContents,
      handleStartRename,
      handleToggleFavorite,
      handleToggleTag,
      isFavorite,
      operationPath,
    ]
  );

  // Loading 状态
  if (loading) {
    return (
      <div className="bg-background/60 flex h-full items-center justify-center">
        <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
      </div>
    );
  }

  // Error 状态
  if (error) {
    const needsAccess = isPermissionDeniedError(error);
    const handleRequestAccess = async () => {
      setRequestingAccess(true);
      try {
        const accessiblePath = await requestDirectoryAccess(
          currentPath,
          t("file_list.permission_title")
        );
        if (accessiblePath) {
          onNavigate(accessiblePath);
        }
      } catch (accessError) {
        console.error("Failed to authorize directory:", accessError);
      } finally {
        setRequestingAccess(false);
      }
    };

    return (
      <div className="bg-background/60 flex h-full items-center justify-center">
        <div className="flex max-w-lg flex-col items-center gap-3 px-6 text-center">
          <div className="text-destructive">
            {error.includes("Path does not exist") ? t("file_list.error_path_not_exists") : error}
          </div>
          {needsAccess && (
            <>
              <p className="text-muted-foreground text-sm">{t("file_list.permission_desc")}</p>
              <button
                type="button"
                className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5 text-sm disabled:opacity-50"
                onClick={handleRequestAccess}
                disabled={requestingAccess}
              >
                {requestingAccess
                  ? t("file_list.permission_requesting")
                  : t("file_list.permission_action")}
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // 空文件夹提示
  const emptyMessage = entries.length === 0 && (
    <div className="text-muted-foreground flex h-32 items-center justify-center">
      {currentPath.startsWith(SMART_FOLDER_PREFIX)
        ? t("file_list.empty_smart_folder")
        : t("file_list.empty_folder")}
    </div>
  );

  return (
    <>
      <AppContextMenu
        type="empty-area"
        emptyAreaActions={{
          onPaste: handlePaste,
          onRefresh: () => loadEntries(false, true),
          onNewFile: handleNewFile,
          onNewFolder: handleNewFolder,
          onOpenInTerminal: handleOpenInTerminal,
          onSort: handleSort,
          onArrange: () => handleArrange(),
          onArrangeBy: handleArrange,
          sortField,
          sortDirection,
          commands: {
            paste: fileCommands.paste,
            newFile: fileCommands.newFile,
            newFolder: fileCommands.newFolder,
          },
          currentPath,
        }}
      >
        <div
          data-view={viewMode}
          className={`finder-files relative h-full overflow-hidden transition-colors ${
            isFileDragOver ? "ring-primary/30 ring-2 ring-inset" : ""
          }`}
          tabIndex={0}
          onDragOver={handleFileContainerDragOver}
          onDragLeave={handleFileContainerDragLeave}
          onDrop={handleFileContainerDrop}
        >
          <FolderSharpnessPanel
            key={currentPath}
            entries={folderScanEntries}
            verdicts={visibleSharpness}
            enabled={!loading && !error}
            onLocate={(entry) => {
              const parent = entry.path.slice(0, entry.path.lastIndexOf("/")) || "/";
              if (parent !== currentPath || viewMode === "column") {
                onNavigate(parent, entry.path);
                return;
              }
              const index = sortedEntries.findIndex((item) => item.path === entry.path);
              selectSingle(entry.path, index);
              if (viewMode === "list") listVirtualizer.scrollToIndex(index, { align: "center" });
              else
                gridVirtualizer.scrollToIndex(Math.floor(index / gridColumns), { align: "center" });
            }}
          />
          {viewMode === "gallery" ? (
            <FileGalleryView
              entries={sortedEntries}
              selectedPath={selectedPath}
              selectedPaths={selectedPaths}
              selectedFileEntries={selectedFileEntries}
              fileActions={fileActions}
              visibleSharpness={visibleSharpness}
              onSelect={(entry, index, event) => handleClick(entry, index, event)}
              onSelectSingle={selectSingle}
              onDoubleClick={handleOpen}
            />
          ) : viewMode === "column" ? (
            <FileColumnView
              currentPath={currentPath}
              selectedPaths={selectedPaths}
              focusedPath={selectedPath}
              selectedFileEntries={selectedFileEntries}
              fileActions={fileActions}
              editingPath={editingPath}
              editValue={editValue}
              onEditValueChange={setEditValue}
              onSubmitRename={handleSubmitRename}
              onCancelRename={handleCancelRename}
              onContextChange={setColumnSelectionContext}
              navigationRef={columnNavRef}
              onSelectSingle={selectSingle}
              onClick={(entry, index, columnEntries, e) =>
                handleClick(entry, index, e, columnEntries)
              }
              onDoubleClick={handleOpen}
              onNavigate={(path) => onNavigate(path)}
              handleMove={handleMove}
              handleCopyTo={handleCopyTo}
              showHiddenFiles={showHiddenFiles}
            />
          ) : viewMode === "list" ? (
            <>
              <FileListHeader
                sortField={sortField}
                sortDirection={sortDirection}
                onSort={handleSort}
              />
              {emptyMessage}
              <div
                ref={listScrollRef}
                onMouseDown={handleListMarqueeMouseDown}
                className="finder-list-scroll relative h-[calc(100%-2.5rem)] overflow-y-auto select-none"
              >
                <div
                  style={{
                    height: `${listVirtualizer.getTotalSize()}px`,
                    width: "100%",
                    position: "relative",
                  }}
                >
                  {listMarqueeRect && (
                    <div
                      className="border-primary/70 bg-primary/15 pointer-events-none absolute z-30 rounded-[2px] border"
                      style={{
                        left: `${listMarqueeRect.left}px`,
                        top: `${listMarqueeRect.top}px`,
                        width: `${listMarqueeRect.width}px`,
                        height: `${listMarqueeRect.height}px`,
                      }}
                    />
                  )}
                  {listVirtualizer.getVirtualItems().map((virtualItem) => {
                    const entry = sortedEntries[virtualItem.index];
                    if (!entry) return null;
                    const dragHandlers = makeDragHandlers(
                      entry,
                      selectedPaths,
                      handleMove,
                      handleCopyTo,
                      false
                    );
                    return (
                      <div
                        key={entry.path}
                        data-index={virtualItem.index}
                        data-marquee-item="true"
                        data-marquee-path={entry.path}
                        ref={listVirtualizer.measureElement}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          transform: `translateY(${virtualItem.start}px)`,
                        }}
                        {...dragHandlers}
                      >
                        <AppContextMenu
                          type={entry.is_dir ? "folder" : "file"}
                          entry={entry}
                          selectedEntries={selectedFileEntries}
                          fileActions={fileActions}
                        >
                          <FileListItem
                            entry={entry}
                            index={virtualItem.index}
                            visibleSharpness={visibleSharpness.get(entry.path)}
                            isInViewport={
                              virtualItem.index >= listStart && virtualItem.index <= listEnd
                            }
                            isScrolling={listVirtualizer.isScrolling}
                            isSelected={selectedPathSet.has(entry.path)}
                            isFocused={selectedPath === entry.path}
                            isEditing={editingPath === entry.path}
                            editValue={editValue}
                            onEditValueChange={setEditValue}
                            onSubmitRename={handleSubmitRename}
                            onCancelRename={handleCancelRename}
                            onItemClick={handleClick}
                            onItemNameClick={handleNameClick}
                            onItemDoubleClick={handleOpen}
                            columnWidths={listColumnWidths}
                            columnVisibility={listColumnVisibility}
                          />
                        </AppContextMenu>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          ) : (
            <>
              {emptyMessage}
              <div
                ref={gridScrollRef}
                onMouseDown={handleGridMarqueeMouseDown}
                className="file-grid-scrollbar relative h-full overflow-y-scroll select-none"
              >
                <div
                  style={{
                    height: `${gridVirtualizer.getTotalSize()}px`,
                    width: "100%",
                    position: "relative",
                  }}
                >
                  {gridMarqueeRect && (
                    <div
                      className="border-primary/70 bg-primary/15 pointer-events-none absolute z-30 rounded-[2px] border"
                      style={{
                        left: `${gridMarqueeRect.left}px`,
                        top: `${gridMarqueeRect.top}px`,
                        width: `${gridMarqueeRect.width}px`,
                        height: `${gridMarqueeRect.height}px`,
                      }}
                    />
                  )}
                  {gridVirtualizer.getVirtualItems().map((virtualRow) => {
                    const cols = gridColumns;
                    const startIdx = virtualRow.index * cols;
                    const rowEntries = sortedEntries.slice(startIdx, startIdx + cols);
                    return (
                      <div
                        key={virtualRow.index}
                        data-index={virtualRow.index}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          height: `${virtualRow.size}px`,
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        <div
                          className="grid gap-3 p-2"
                          style={{
                            gridTemplateColumns: `repeat(${cols}, minmax(0, ${gridItemWidth}px))`,
                          }}
                        >
                          {rowEntries.map((entry, colIdx) => {
                            const globalIndex = startIdx + colIdx;
                            const dragHandlers = makeDragHandlers(
                              entry,
                              selectedPaths,
                              handleMove,
                              handleCopyTo,
                              true
                            );
                            const analysis = photoAnalysis.get(entry.path);
                            return (
                              <div
                                key={entry.path}
                                data-marquee-item="true"
                                data-marquee-path={entry.path}
                                {...dragHandlers}
                              >
                                <AppContextMenu
                                  type={entry.is_dir ? "folder" : "file"}
                                  entry={entry}
                                  selectedEntries={selectedFileEntries}
                                  fileActions={fileActions}
                                >
                                  <FileGridItem
                                    entry={entry}
                                    index={globalIndex}
                                    isSelected={selectedPathSet.has(entry.path)}
                                    isFocused={selectedPath === entry.path}
                                    isEditing={editingPath === entry.path}
                                    editValue={editValue}
                                    onEditValueChange={setEditValue}
                                    onSubmitRename={handleSubmitRename}
                                    onCancelRename={handleCancelRename}
                                    onItemClick={handleClick}
                                    onItemNameClick={handleNameClick}
                                    onItemDoubleClick={handleOpen}
                                    photoAnalysis={analysis}
                                    visibleSharpness={visibleSharpness.get(entry.path)}
                                    photoAnalysisEnabled={photoAnalysisEnabled}
                                    iconSize={iconSize}
                                    isScrolling={gridIsScrolling}
                                    isInViewport={gridViewportPathSet.has(entry.path)}
                                    photoGroupColor={getPhotoGroupColor(analysis?.groupId ?? null)}
                                  />
                                </AppContextMenu>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </AppContextMenu>

      {!useNativeQuickLook && (
        <QuickLook
          entry={quickLookEntry}
          entries={sortedEntries}
          photoAnalysis={photoAnalysis}
          onClose={() => setQuickLookEntry(null)}
          onNavigate={(entry) => {
            const index = sortedEntries.findIndex((candidate) => candidate.path === entry.path);
            selectSingle(entry.path, index);
            if (index >= 0) {
              if (viewMode === "icon") {
                gridVirtualizer.scrollToIndex(Math.floor(index / gridColumns), { align: "auto" });
              } else if (viewMode === "list") {
                listVirtualizer.scrollToIndex(index, { align: "auto" });
              }
            }
            setQuickLookEntry(entry);
          }}
        />
      )}

      <BatchRenameDialog
        open={showBatchRename}
        onOpenChange={setShowBatchRename}
        selectedFiles={batchRenameFiles}
        onComplete={() => loadEntries(false)}
      />
    </>
  );
}

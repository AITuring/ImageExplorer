import { useEffect, useMemo, useRef, useCallback, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AppContextMenu } from "@/components/AppContextMenu";
import { FileEntry, FileActions } from "@/types";
import { useViewMode } from "@/stores/viewMode";
import { usePhotoAnalysisMode } from "@/stores/photoAnalysisMode";
import { useTabs } from "@/hooks/useTabs";
import { QuickLook } from "@/components/QuickLook";
import { SMART_FOLDER_PREFIX } from "@/constants/config";
import { invoke } from "@tauri-apps/api/core";
import { useFileSort } from "./hooks/useFileSort";
import { useFileSelection } from "./hooks/useFileSelection";
import { useFileOperations } from "./hooks/useFileOperations";
import { useFileKeyboardShortcuts } from "./hooks/useFileKeyboardShortcuts";
import { useFileEntries } from "./hooks/useFileEntries";
import { useFileRename } from "./hooks/useFileRename";
import { useQuickLook } from "./hooks/useQuickLook";
import { usePhotoAnalysis } from "@/hooks/usePhotoAnalysis";
import { getPhotoGroupColor } from "@/lib/photoAnalysis";
import { FileListHeader } from "./components/FileListHeader";
import { FileListItem } from "./components/FileListItem";
import { FileGridItem } from "./components/FileGridItem";
import { FileColumnView } from "./components/FileColumnView";
import { FileGalleryView } from "./components/FileGalleryView";
import { BatchRenameDialog } from "@/components/BatchRenameDialog";
import { FILE_DRAG_MIME, readFileDragData, serializeFileDragData } from "@/lib/dragData";
import { isPermissionDeniedError, requestDirectoryAccess } from "@/lib/directoryAccess";

/** 列表视图固定行高 */
const LIST_ITEM_HEIGHT = 40;
/** 网格视图固定行高 */
const GRID_ROW_HEIGHT = 216;
/** 网格项最小宽度 */
const GRID_ITEM_MIN_WIDTH = 132;
/** 网格间距 */
const GRID_GAP = 16;

interface FileListProps {
  currentPath: string;
  onNavigate: (path: string, selectFile?: string) => void;
  fileToSelect?: string | null;
}

/** 拖拽事件处理工厂 */
function makeDragHandlers(
  entry: FileEntry,
  handleMove: (src: string, dest: string) => void,
  isGrid: boolean
) {
  return {
    onDragStart: (e: React.DragEvent) => {
      const serialized = serializeFileDragData([entry.path]);
      e.dataTransfer.setData(FILE_DRAG_MIME, serialized);
      e.dataTransfer.setData("application/json", serialized);
      // 跨 WebView/窗口时 text/plain 的可用性最好。
      e.dataTransfer.setData("text/plain", serialized);
      e.dataTransfer.effectAllowed = "move";
    },
    onDragOver: (e: React.DragEvent) => {
      if (!entry.is_dir) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
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
      if (isGrid) {
        e.currentTarget.querySelector(".group")?.classList.remove("bg-primary/20", "rounded-lg");
      } else {
        e.currentTarget.classList.remove("bg-primary/20", "rounded-md");
      }
      const data = readFileDragData(e.dataTransfer);
      if (data) {
        data.paths
          .filter((path) => path !== entry.path)
          .forEach((path) => handleMove(path, entry.path));
      }
    },
  };
}

export function FileList({ currentPath, onNavigate, fileToSelect }: FileListProps) {
  const { t } = useTranslation();
  const { viewMode } = useViewMode();
  const { enabled: photoAnalysisEnabled } = usePhotoAnalysisMode();
  const { addTab } = useTabs();

  // 1. 数据加载
  const { entries, showHiddenFiles, loading, error, loadEntries } = useFileEntries(currentPath);
  const [requestingAccess, setRequestingAccess] = useState(false);

  // 2. 排序
  const { sortField, sortDirection, handleSort, handleArrange, sortedEntries } =
    useFileSort(entries);

  // 3. 选择状态
  const {
    selectedPath,
    selectedPaths,
    setSelectedPath,
    selectSingle,
    toggleSelection,
    selectRange,
    selectAll,
    clearSelection,
    editingPath,
    setEditingPath,
    editValue,
    setEditValue,
  } = useFileSelection();

  // 4. 重命名
  const { handleStartRename, handleSubmitRename, handleCancelRename } = useFileRename({
    entries,
    selectedPath,
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
    handleDelete,
    handleCompress,
    handleExtract,
    handleCopyPath,
    handleNewFile,
    handleNewFolder,
    handleOpenInTerminal,
    handleMove,
  } = useFileOperations({
    currentPath,
    onRefresh: () => loadEntries(false),
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
    entries: sortedEntries,
    forceCustomImagePreview: viewMode === "icon" && photoAnalysisEnabled,
  });

  // Finder keeps interactive preview work ahead of background indexing. Pause
  // the folder-wide visual analysis while Quick Look is open, retaining the
  // records already available for the focus marker.
  const { records: photoAnalysis } = usePhotoAnalysis(
    sortedEntries,
    viewMode === "icon" && photoAnalysisEnabled,
    Boolean(quickLookEntry),
    quickLookEntry?.path,
    currentPath
  );

  // 7. 键盘快捷键
  useFileKeyboardShortcuts({
    editingPath,
    selectedPath,
    selectedPaths,
    sortedEntries,
    entries,
    selectAll,
    selectSingle,
    selectRange,
    clearSelection,
    handleCopy,
    handleCut,
    handlePaste,
    handleDelete,
    handleNewFile,
    handleNewFolder,
  });

  // === 虚拟滚动 ===
  const listScrollRef = useRef<HTMLDivElement>(null);
  const gridScrollRef = useRef<HTMLDivElement>(null);
  const galleryScrollRef = useRef<HTMLDivElement>(null);
  const scrollPositionsRef = useRef<Record<string, number>>({});

  const getScrollContainer = useCallback((mode: typeof viewMode) => {
    if (mode === "list") return listScrollRef.current;
    if (mode === "gallery") return galleryScrollRef.current;
    if (mode === "icon") return gridScrollRef.current;
    return null;
  }, []);

  // 计算网格每行列数
  const gridColumnsRef = useRef(6);
  const updateGridColumns = useCallback(() => {
    const el = gridScrollRef.current;
    if (!el) return;
    const containerWidth = el.clientWidth - 16; // p-2 padding
    gridColumnsRef.current = Math.max(
      1,
      Math.floor(containerWidth / (GRID_ITEM_MIN_WIDTH + GRID_GAP))
    );
  }, []);

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
    () => Math.ceil(sortedEntries.length / gridColumnsRef.current),
    [sortedEntries.length]
  );

  // 列表虚拟化
  const listVirtualizer = useVirtualizer({
    count: sortedEntries.length,
    getScrollElement: () => listScrollRef.current,
    estimateSize: () => LIST_ITEM_HEIGHT,
    overscan: 6,
  });

  // 网格虚拟化（按行）
  const gridVirtualizer = useVirtualizer({
    count: gridRowCount,
    getScrollElement: () => gridScrollRef.current,
    estimateSize: () => GRID_ROW_HEIGHT,
    overscan: 4,
  });

  useEffect(() => {
    const locationKey = `${viewMode}:${currentPath}`;
    const scrollPositions = scrollPositionsRef.current;
    return () => {
      const scrollContainer = getScrollContainer(viewMode);
      if (scrollContainer) {
        scrollPositions[locationKey] = scrollContainer.scrollTop;
      }
    };
  }, [currentPath, getScrollContainer, viewMode]);

  useEffect(() => {
    if (loading || fileToSelect) {
      return;
    }

    const savedScrollTop = scrollPositionsRef.current[`${viewMode}:${currentPath}`];
    if (savedScrollTop === undefined) {
      return;
    }

    const restoreScroll = () => {
      const scrollContainer = getScrollContainer(viewMode);
      if (scrollContainer) {
        scrollContainer.scrollTop = savedScrollTop;
      }
    };

    const animationId = window.requestAnimationFrame(restoreScroll);
    return () => window.cancelAnimationFrame(animationId);
  }, [currentPath, fileToSelect, getScrollContainer, loading, viewMode]);

  // 8. 自动选中和滚动
  useEffect(() => {
    if (fileToSelect && entries.length > 0) {
      const entry = entries.find((e) => e.path === fileToSelect);
      if (entry) {
        setSelectedPath(entry.path);
        const idx = sortedEntries.findIndex((e) => e.path === fileToSelect);
        if (idx >= 0) {
          if (viewMode === "list") {
            listVirtualizer.scrollToIndex(idx, { align: "center" });
          } else {
            const rowIdx = Math.floor(idx / gridColumnsRef.current);
            gridVirtualizer.scrollToIndex(rowIdx, { align: "center" });
          }
        }
      }
    }
  }, [
    entries,
    fileToSelect,
    setSelectedPath,
    sortedEntries,
    viewMode,
    listVirtualizer,
    gridVirtualizer,
  ]);

  // 点击处理
  const handleClick = (entry: FileEntry, index: number, e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      toggleSelection(entry.path, index);
    } else if (e.shiftKey) {
      selectRange(sortedEntries, index);
    } else {
      selectSingle(entry.path, index);
    }
  };

  // Finder 风格：点击未选中的文件名先选中，点击已选中文件名进入重命名。
  const handleNameClick = (entry: FileEntry, index: number, e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      handleClick(entry, index, e);
      return;
    }

    if (selectedPaths.includes(entry.path) && !entry.readonly) {
      handleStartRename(entry);
    } else {
      selectSingle(entry.path, index);
    }
  };

  // 跳转到位置
  const handleGoToLocation = async (entry: FileEntry) => {
    try {
      const parentDir = await invoke<string>("get_parent_dir", { path: entry.path });
      if (parentDir) {
        onNavigate(parentDir, entry.path);
      }
    } catch (e) {
      console.error("Failed to go to location:", e);
    }
  };

  // 当前选中的文件列表
  const selectedFileEntries = useMemo(
    () => sortedEntries.filter((e) => selectedPaths.includes(e.path)),
    [sortedEntries, selectedPaths]
  );

  const handleFileContainerDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (e.defaultPrevented) {
        setIsFileDragOver(false);
        return;
      }
      if (currentPath.startsWith(SMART_FOLDER_PREFIX)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setIsFileDragOver(true);
    },
    [currentPath]
  );

  const handleFileContainerDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsFileDragOver(false);
    }
  }, []);

  const handleFileContainerDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (currentPath.startsWith(SMART_FOLDER_PREFIX)) return;
      const data = readFileDragData(e.dataTransfer);
      if (!data) return;

      e.preventDefault();
      e.stopPropagation();
      setIsFileDragOver(false);
      data.paths
        .filter((path) => path !== currentPath)
        .forEach((path) => handleMove(path, currentPath));
    },
    [currentPath, handleMove]
  );

  // 文件操作对象
  const fileActions: FileActions = {
    onOpen: handleOpen,
    onOpenInNewTab: (entry) => {
      if (entry.is_dir) addTab(entry.path);
    },
    onCopy: handleCopy,
    onCut: handleCut,
    onPaste: handlePaste,
    onCopyPath: handleCopyPath,
    onDelete: handleDelete,
    onCompress: handleCompress,
    onExtract: handleExtract,
    onRename: handleStartRename,
    onGoToLocation: currentPath.startsWith(SMART_FOLDER_PREFIX) ? handleGoToLocation : undefined,
    onBatchRename: (entries: FileEntry[]) => {
      setBatchRenameFiles(entries);
      setShowBatchRename(true);
    },
    currentPath,
  };

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
          onRefresh: loadEntries,
          onNewFile: handleNewFile,
          onNewFolder: handleNewFolder,
          onOpenInTerminal: handleOpenInTerminal,
          onSort: handleSort,
          onArrange: () => handleArrange(),
          onArrangeBy: handleArrange,
          sortField,
          sortDirection,
          currentPath,
        }}
      >
        <div
          className={`bg-background/60 h-full overflow-hidden p-4 transition-colors ${
            isFileDragOver ? "ring-primary/30 ring-2 ring-inset" : ""
          }`}
          tabIndex={0}
          onDragOver={handleFileContainerDragOver}
          onDragLeave={handleFileContainerDragLeave}
          onDrop={handleFileContainerDrop}
        >
          {viewMode === "column" ? (
            <FileColumnView
              currentPath={currentPath}
              selectedPaths={selectedPaths}
              onClick={(entry, index, e) => handleClick(entry, index, e)}
              onDoubleClick={handleOpen}
              onNavigate={(path) => onNavigate(path)}
              showHiddenFiles={showHiddenFiles}
            />
          ) : viewMode === "gallery" ? (
            <FileGalleryView
              sortedEntries={sortedEntries}
              selectedPaths={selectedPaths}
              selectedFileEntries={selectedFileEntries}
              editingPath={editingPath}
              editValue={editValue}
              fileActions={fileActions}
              onEditValueChange={setEditValue}
              onSubmitRename={handleSubmitRename}
              onCancelRename={handleCancelRename}
              onClick={(entry, index, e) => handleClick(entry, index, e)}
              onDoubleClick={handleOpen}
              handleMove={handleMove}
              scrollContainerRef={galleryScrollRef}
            />
          ) : viewMode === "list" ? (
            <>
              <FileListHeader
                sortField={sortField}
                sortDirection={sortDirection}
                onSort={handleSort}
              />
              {emptyMessage}
              <div ref={listScrollRef} className="h-[calc(100%-2.5rem)] overflow-y-auto">
                <div
                  style={{
                    height: `${listVirtualizer.getTotalSize()}px`,
                    width: "100%",
                    position: "relative",
                  }}
                >
                  {listVirtualizer.getVirtualItems().map((virtualItem) => {
                    const entry = sortedEntries[virtualItem.index];
                    if (!entry) return null;
                    const dragHandlers = makeDragHandlers(entry, handleMove, false);
                    return (
                      <div
                        key={entry.path}
                        data-index={virtualItem.index}
                        ref={listVirtualizer.measureElement}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          transform: `translateY(${virtualItem.start}px)`,
                        }}
                        draggable
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
                            isSelected={selectedPaths.includes(entry.path)}
                            isEditing={editingPath === entry.path}
                            editValue={editValue}
                            onEditValueChange={setEditValue}
                            onSubmitRename={handleSubmitRename}
                            onCancelRename={handleCancelRename}
                            onClick={(e) => handleClick(entry, virtualItem.index, e)}
                            onNameClick={(e) => handleNameClick(entry, virtualItem.index, e)}
                            onDoubleClick={() => handleOpen(entry)}
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
              <div ref={gridScrollRef} className="h-full overflow-y-auto">
                <div
                  style={{
                    height: `${gridVirtualizer.getTotalSize()}px`,
                    width: "100%",
                    position: "relative",
                  }}
                >
                  {gridVirtualizer.getVirtualItems().map((virtualRow) => {
                    const cols = gridColumnsRef.current;
                    const startIdx = virtualRow.index * cols;
                    const rowEntries = sortedEntries.slice(startIdx, startIdx + cols);
                    return (
                      <div
                        key={virtualRow.index}
                        data-index={virtualRow.index}
                        ref={gridVirtualizer.measureElement}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        <div
                          className="grid gap-4 p-2"
                          style={{
                            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                          }}
                        >
                          {rowEntries.map((entry, colIdx) => {
                            const globalIndex = startIdx + colIdx;
                            const dragHandlers = makeDragHandlers(entry, handleMove, true);
                            const analysis = photoAnalysis.get(entry.path);
                            return (
                              <div key={entry.path} draggable {...dragHandlers}>
                                <AppContextMenu
                                  type={entry.is_dir ? "folder" : "file"}
                                  entry={entry}
                                  selectedEntries={selectedFileEntries}
                                  fileActions={fileActions}
                                >
                                  <FileGridItem
                                    entry={entry}
                                    isSelected={selectedPaths.includes(entry.path)}
                                    isEditing={editingPath === entry.path}
                                    editValue={editValue}
                                    onEditValueChange={setEditValue}
                                    onSubmitRename={handleSubmitRename}
                                    onCancelRename={handleCancelRename}
                                    onClick={(e) => handleClick(entry, globalIndex, e)}
                                    onNameClick={(e) => handleNameClick(entry, globalIndex, e)}
                                    onDoubleClick={() => handleOpen(entry)}
                                    photoAnalysis={analysis}
                                    photoAnalysisEnabled={photoAnalysisEnabled}
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
          onNavigate={setQuickLookEntry}
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

import {
  lazy,
  startTransition,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, Filter, Loader2 } from "lucide-react";
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
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
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
import { getLatestSharpnessMap, useVisibleSharpness } from "@/hooks/useVisibleSharpness";
import { getPhotoGroupColor, isAnalyzablePhoto } from "@/lib/photoAnalysis";
import {
  getCachedPhotoMetadata,
  hydratePhotoMetadataCache,
  subscribeAnyPhotoMetadataUpdate,
} from "@/lib/photoMetadata";
import { usePhotoCulling, usePhotoCullingEntry } from "@/hooks/usePhotoCulling";
import {
  exportXmpSidecars,
  updatePhotoCullingStates,
  type PhotoCullingState,
  type PhotoFlag,
} from "@/lib/photoCulling";
import { computeAutoPickBest } from "@/lib/autoPickBest";
import { enqueueFileOperation } from "@/lib/fileOperations";
import { windowManager } from "@/lib/windowManager";
import {
  DEFAULT_FOLDER_FILTER,
  filterFolderEntries,
  hasActiveFolderFilter,
  type FolderFilterState,
} from "@/lib/folderFilter";
import { expandPairedEntries, pairRawAndJpegEntries } from "@/lib/rawJpegPairing";
import { groupFileEntries, type EntryGroup } from "@/lib/finderGrouping";
import { sortFileEntries } from "./hooks/finderListModel";
import { filterHiddenEntries } from "@/utils/file";
import { FileListHeader } from "./components/FileListHeader";
import { FileListItem } from "./components/FileListItem";
import { FileGridItem } from "./components/FileGridItem";
import { FileGalleryView } from "./components/FileGalleryView";
import { FolderFilterBar } from "./components/FolderFilterBar";
import {
  FileColumnView,
  type ColumnNavigationHandle,
  type ColumnSelectionContext,
} from "./components/FileColumnView";

const PhotoCompareDialog = lazy(() =>
  import("@/components/PhotoCompareDialog").then((m) => ({ default: m.PhotoCompareDialog }))
);
const BatchRenameDialog = lazy(() =>
  import("@/components/BatchRenameDialog").then((m) => ({ default: m.BatchRenameDialog }))
);
import { readFileDragData } from "@/lib/dragData";
import { makeDelegatedFileDragGestureHandlers } from "@/lib/nativeFileDragGesture";
import { isPermissionDeniedError, requestDirectoryAccess } from "@/lib/directoryAccess";
import { settingsManager } from "@/lib/store";
import { useStatusBar } from "@/stores/statusBar";
import { useBatchExportDialog } from "@/stores/batchExportDialog";
import { useExhibitLabelDialog } from "@/stores/exhibitLabelDialog";
import { usePeopleClusterDialog } from "@/stores/peopleClusterDialog";
import { useExifSyncDialog } from "@/stores/exifSyncDialog";

/** 列表视图固定行高 */
const LIST_ITEM_HEIGHT = 32;
/** 分组标题行高 */
const GROUP_HEADER_HEIGHT = 28;
/** 文件夹行保持 Finder 式紧凑间距 */
const GRID_ROW_HEIGHT = 116;

type ListRenderRow =
  | { kind: "group"; group: EntryGroup }
  | {
      kind: "entry";
      entry: FileEntry;
      flatIndex: number;
      depth: number;
      parentPath: string | null;
      canExpand: boolean;
      isExpanded: boolean;
      isLoadingChildren: boolean;
    };

type GridRenderRow =
  | { kind: "group"; group: EntryGroup }
  | { kind: "entries"; entries: FileEntry[]; startFlatIndex: number };
/** 网格项最小宽度 */
const GRID_ITEM_MIN_WIDTH = 132;
/** 网格间距 */
const GRID_GAP = 12;

interface FileListProps {
  currentPath: string;
  onNavigate: (path: string, selectFile?: string) => void;
  fileToSelect?: string | null;
  isPrimaryPane?: boolean;
}

/** 仅文件夹需要的拖入目标事件处理（按住 Option / Alt 键执行复制而非移动） */
function makeDirectoryDropHandlers(
  entry: FileEntry,
  handleMove: (src: string | string[], dest: string) => void,
  handleCopyTo: (src: string | string[], dest: string) => void,
  isGrid: boolean
) {
  if (!entry.is_dir) return undefined;

  return {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
      if (isGrid) {
        e.currentTarget.querySelector(".group")?.classList.add("bg-primary/20", "rounded-lg");
      } else {
        e.currentTarget.classList.add("bg-primary/20", "rounded-md");
      }
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
        if (isGrid) {
          e.currentTarget.querySelector(".group")?.classList.remove("bg-primary/20", "rounded-lg");
        } else {
          e.currentTarget.classList.remove("bg-primary/20", "rounded-md");
        }
      }
    },
    onDrop: (e: React.DragEvent) => {
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

const EMPTY_SHARPNESS_MAP: ReadonlyMap<string, "sharp" | "soft" | "unavailable"> = new Map();
const EMPTY_CULLING_MAP: ReadonlyMap<string, PhotoCullingState> = new Map();

export function FileList({
  currentPath,
  onNavigate,
  fileToSelect,
  isPrimaryPane = true,
}: FileListProps) {
  const { t } = useTranslation();
  const {
    viewMode,
    groupBy,
    iconSize,
    listColumnWidths,
    listColumnVisibility,
    cullAutoAdvance,
    toggleCullAutoAdvance,
  } = useViewMode();
  // Photo details and analysis are available automatically in every view.
  const photoAnalysisEnabled = true;
  const { addTab, activeTab, goBack, goForward, canGoBack, canGoForward } = useTabs();
  const setStatusBar = useStatusBar((state) => state.setStatus);
  const openBatchExport = useBatchExportDialog((state) => state.open);
  const openExhibitLabel = useExhibitLabelDialog((state) => state.open);
  const openPeopleCluster = usePeopleClusterDialog((state) => state.open);
  const openExifSync = useExifSyncDialog((state) => state.open);
  const [legacyTabNumberShortcuts] = useSetting<boolean>("legacy_cmd_number_tabs", false);
  const [gridColumns, setGridColumns] = useState(6);
  const [columnSelectionContext, setColumnSelectionContext] =
    useState<ColumnSelectionContext | null>(null);
  const columnNavRef = useRef<ColumnNavigationHandle | null>(null);
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  const [folderFilter, setFolderFilter] = useState<FolderFilterState>(DEFAULT_FOLDER_FILTER);
  const [filterBarOpen, setFilterBarOpen] = useState(false);
  const [tabBarStatusSlot, setTabBarStatusSlot] = useState<HTMLElement | null>(() =>
    isPrimaryPane && typeof document !== "undefined"
      ? document.getElementById("tabbar-status-slot")
      : null
  );
  const [compareEntries, setCompareEntries] = useState<FileEntry[] | null>(null);

  useEffect(() => {
    if (!isPrimaryPane) return;
    const el = document.getElementById("tabbar-status-slot");
    if (el && el !== tabBarStatusSlot) {
      queueMicrotask(() => setTabBarStatusSlot(el));
    }
  }, [isPrimaryPane, tabBarStatusSlot]);

  // 1. 数据加载
  const { entries, showHiddenFiles, loading, error, loadEntries } = useFileEntries(currentPath);
  const [requestingAccess, setRequestingAccess] = useState(false);

  // Batch-hydrate EXIF shooting parameters from SQLite once per directory load.
  useEffect(() => {
    if (!loading && !error && entries.length > 0) {
      void hydratePhotoMetadataCache(entries);
    }
  }, [entries, error, loading]);

  // Reset per-folder text/tag/sharpness filters when navigating to another folder,
  // while preserving the user's RAW+JPG stacking preference.
  const previousPathRef = useRef(currentPath);
  useEffect(() => {
    if (previousPathRef.current !== currentPath) {
      previousPathRef.current = currentPath;
      setFolderFilter((current) => ({
        ...DEFAULT_FOLDER_FILTER,
        pairRawJpeg: current.pairRawJpeg,
      }));
      setFilterBarOpen(false);
    }
  }, [currentPath]);

  const folderScanEntries = useMemo(
    () =>
      entries.filter(
        (entry) =>
          currentPath.startsWith(SMART_FOLDER_PREFIX) ||
          (entry.path.slice(0, entry.path.lastIndexOf("/")) || "/") === currentPath
      ),
    [entries, currentPath]
  );

  const hasPhotosInFolder = useMemo(
    () => entries.some((entry) => isAnalyzablePhoto(entry)),
    [entries]
  );

  const pairingPreview = useMemo(() => pairRawAndJpegEntries(entries), [entries]);
  const pairedCompanionsByPath = useMemo(
    () =>
      folderFilter.pairRawJpeg
        ? pairingPreview.companionsByPrimaryPath
        : new Map<string, FileEntry[]>(),
    [folderFilter.pairRawJpeg, pairingPreview.companionsByPrimaryPath]
  );
  const displayBaseEntries = folderFilter.pairRawJpeg ? pairingPreview.entries : entries;

  const viewportPriorityPathsRef = useRef<string[]>([]);
  const [quickLookOpenFlag, setQuickLookOpenFlag] = useState(false);
  const [contextMenuTarget, setContextMenuTarget] = useState<FileEntry | null>(null);

  const hasSharpnessFilterActive = folderFilter.sharpness !== "all";
  const hasCullingFilterActive = folderFilter.flag !== "all" || folderFilter.minRating > 0;
  const needsSharpnessMap =
    hasSharpnessFilterActive || viewMode === "gallery" || compareEntries !== null;
  const needsCullingMap =
    hasCullingFilterActive || viewMode === "gallery" || compareEntries !== null;

  const visibleSharpness = useVisibleSharpness(
    folderScanEntries,
    !loading && !error && !quickLookOpenFlag,
    viewportPriorityPathsRef,
    needsSharpnessMap
  );

  const cullingMap = usePhotoCulling(entries, needsCullingMap);
  const [metadataTick, setMetadataTick] = useState(0);
  useEffect(() => {
    return subscribeAnyPhotoMetadataUpdate(() => {
      startTransition(() => {
        setMetadataTick((tick) => tick + 1);
      });
    });
  }, []);

  const hasExifFilterActive = folderFilter.cameraModel !== null || folderFilter.lensModel !== null;
  const exifFilterTick = hasExifFilterActive ? metadataTick : 0;

  const { cameraOptions, lensOptions } = useMemo(() => {
    void metadataTick;
    const cameras = new Set<string>();
    const lenses = new Set<string>();
    for (const entry of displayBaseEntries) {
      if (entry.is_dir) continue;
      const meta = getCachedPhotoMetadata(entry);
      if (meta?.model) cameras.add(meta.model);
      if (meta?.lens) lenses.add(meta.lens);
    }
    return {
      cameraOptions: [...cameras].sort(),
      lensOptions: [...lenses].sort(),
    };
  }, [displayBaseEntries, metadataTick]);

  const sharpnessForFilter = hasSharpnessFilterActive ? visibleSharpness : EMPTY_SHARPNESS_MAP;
  const cullingForFilter = hasCullingFilterActive ? cullingMap : EMPTY_CULLING_MAP;

  const filteredEntries = useMemo(() => {
    void exifFilterTick;
    return filterFolderEntries(
      displayBaseEntries,
      folderFilter,
      sharpnessForFilter,
      cullingForFilter,
      getCachedPhotoMetadata
    );
  }, [cullingForFilter, displayBaseEntries, exifFilterTick, folderFilter, sharpnessForFilter]);

  // 2. 排序（仅在按 EXIF 拍摄时间排序时才因元数据到达而重排，避免大目录反复全量重排）
  const getCapturedAt = useCallback(
    (entry: FileEntry) => getCachedPhotoMetadata(entry)?.capturedAt,
    []
  );
  const { sortField, sortDirection, handleSort, handleArrange, sortedEntries } = useFileSort(
    filteredEntries,
    getCapturedAt,
    metadataTick
  );
  const allPhotosInView = useMemo(() => sortedEntries.filter(isAnalyzablePhoto), [sortedEntries]);

  // 2b. 分组折叠状态 + 列表视图内联展开子文件夹状态
  const groupCollapseKey = `${currentPath}:${groupBy}`;
  const [collapsedGroupsState, setCollapsedGroupsState] = useState<{
    key: string;
    ids: string[];
  }>({ key: "", ids: [] });
  const collapsedGroupSet = useMemo(
    () =>
      collapsedGroupsState.key === groupCollapseKey
        ? new Set(collapsedGroupsState.ids)
        : new Set<string>(),
    [collapsedGroupsState, groupCollapseKey]
  );
  const toggleGroupCollapsed = useCallback(
    (groupId: string) => {
      setCollapsedGroupsState((prev) => {
        const currentIds = prev.key === groupCollapseKey ? prev.ids : [];
        const exists = currentIds.includes(groupId);
        return {
          key: groupCollapseKey,
          ids: exists ? currentIds.filter((id) => id !== groupId) : [...currentIds, groupId],
        };
      });
    },
    [groupCollapseKey]
  );

  const [listTreeState, setListTreeState] = useState<{
    rootPath: string;
    expanded: Record<string, boolean>;
    children: Record<string, FileEntry[]>;
    loading: Record<string, boolean>;
  }>({ rootPath: "", expanded: {}, children: {}, loading: {} });

  const activeListTree = useMemo(
    () =>
      listTreeState.rootPath === currentPath
        ? listTreeState
        : { rootPath: currentPath, expanded: {}, children: {}, loading: {} },
    [currentPath, listTreeState]
  );

  const handleToggleExpandDir = useCallback(
    (entry: FileEntry) => {
      if (!entry.is_dir || (entry.is_package && entry.package_type === "app")) return;
      const dirPath = entry.path;
      const currentlyExpanded = Boolean(activeListTree.expanded[dirPath]);
      if (currentlyExpanded) {
        setListTreeState((prev) => ({
          rootPath: currentPath,
          expanded: { ...(prev.rootPath === currentPath ? prev.expanded : {}), [dirPath]: false },
          children: prev.rootPath === currentPath ? prev.children : {},
          loading: prev.rootPath === currentPath ? prev.loading : {},
        }));
        return;
      }

      const alreadyLoaded = Boolean(activeListTree.children[dirPath]);
      setListTreeState((prev) => ({
        rootPath: currentPath,
        expanded: { ...(prev.rootPath === currentPath ? prev.expanded : {}), [dirPath]: true },
        children: prev.rootPath === currentPath ? prev.children : {},
        loading: {
          ...(prev.rootPath === currentPath ? prev.loading : {}),
          [dirPath]: !alreadyLoaded,
        },
      }));

      if (!alreadyLoaded) {
        void invoke<FileEntry[]>("get_entries", { path: dirPath, forceRefresh: false })
          .then((rawChildren) => {
            const visible = filterHiddenEntries(rawChildren, showHiddenFiles);
            setListTreeState((prev) => {
              if (prev.rootPath !== currentPath) return prev;
              return {
                ...prev,
                children: { ...prev.children, [dirPath]: visible },
                loading: { ...prev.loading, [dirPath]: false },
              };
            });
          })
          .catch(() => {
            setListTreeState((prev) => {
              if (prev.rootPath !== currentPath) return prev;
              return {
                ...prev,
                expanded: { ...prev.expanded, [dirPath]: false },
                loading: { ...prev.loading, [dirPath]: false },
              };
            });
          });
      }
    },
    [activeListTree.children, activeListTree.expanded, currentPath, showHiddenFiles]
  );

  const entryGroups = useMemo(
    () => (groupBy === "none" ? [] : groupFileEntries(sortedEntries, groupBy)),
    [groupBy, sortedEntries]
  );

  const { listRows, flatListEntries, listEntryRowIndexByPath, listParentPathByPath } =
    useMemo(() => {
      const rows: ListRenderRow[] = [];
      const flat: FileEntry[] = [];
      const rowIndexMap = new Map<string, number>();
      const parentMap = new Map<string, string>();

      if (groupBy !== "none") {
        for (const group of entryGroups) {
          rows.push({ kind: "group", group });
          if (collapsedGroupSet.has(group.id)) continue;
          for (const entry of group.entries) {
            const flatIndex = flat.length;
            flat.push(entry);
            rowIndexMap.set(entry.path, rows.length);
            rows.push({
              kind: "entry",
              entry,
              flatIndex,
              depth: 0,
              parentPath: null,
              canExpand: false,
              isExpanded: false,
              isLoadingChildren: false,
            });
          }
        }
      } else {
        const allowTreeExpand = !currentPath.startsWith(SMART_FOLDER_PREFIX);
        const visit = (items: FileEntry[], depth: number, parentPath: string | null) => {
          for (const entry of items) {
            const canExpand =
              allowTreeExpand &&
              entry.is_dir &&
              !(entry.is_package && entry.package_type === "app");
            const isExpanded = canExpand && Boolean(activeListTree.expanded[entry.path]);
            const isLoadingChildren = canExpand && Boolean(activeListTree.loading[entry.path]);
            const flatIndex = flat.length;
            flat.push(entry);
            if (parentPath) parentMap.set(entry.path, parentPath);
            rowIndexMap.set(entry.path, rows.length);
            rows.push({
              kind: "entry",
              entry,
              flatIndex,
              depth,
              parentPath,
              canExpand,
              isExpanded,
              isLoadingChildren,
            });
            if (isExpanded && depth < 6) {
              const rawKids = activeListTree.children[entry.path];
              if (rawKids && rawKids.length > 0) {
                const sortedKids = sortFileEntries(
                  rawKids,
                  sortField,
                  sortDirection,
                  getCapturedAt
                );
                visit(sortedKids, depth + 1, entry.path);
              }
            }
          }
        };
        visit(sortedEntries, 0, null);
      }

      return {
        listRows: rows,
        flatListEntries: flat,
        listEntryRowIndexByPath: rowIndexMap,
        listParentPathByPath: parentMap,
      };
    }, [
      activeListTree.children,
      activeListTree.expanded,
      activeListTree.loading,
      collapsedGroupSet,
      currentPath,
      entryGroups,
      getCapturedAt,
      groupBy,
      sortDirection,
      sortField,
      sortedEntries,
    ]);

  const { gridRows, flatGridEntries, gridRowIndexByPath } = useMemo(() => {
    const rows: GridRenderRow[] = [];
    const flat: FileEntry[] = [];
    const rowIndexMap = new Map<string, number>();
    const cols = Math.max(1, gridColumns);

    const pushChunked = (items: FileEntry[]) => {
      for (let i = 0; i < items.length; i += cols) {
        const slice = items.slice(i, i + cols);
        const startFlatIndex = flat.length;
        const rowIdx = rows.length;
        for (const item of slice) {
          flat.push(item);
          rowIndexMap.set(item.path, rowIdx);
        }
        rows.push({ kind: "entries", entries: slice, startFlatIndex });
      }
    };

    if (groupBy !== "none") {
      for (const group of entryGroups) {
        rows.push({ kind: "group", group });
        if (!collapsedGroupSet.has(group.id)) {
          pushChunked(group.entries);
        }
      }
    } else {
      pushChunked(sortedEntries);
    }

    return { gridRows: rows, flatGridEntries: flat, gridRowIndexByPath: rowIndexMap };
  }, [collapsedGroupSet, entryGroups, gridColumns, groupBy, sortedEntries]);

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
        : viewMode === "list"
          ? flatListEntries
          : viewMode === "icon"
            ? flatGridEntries
            : sortedEntries,
    [activeColumnContext, flatGridEntries, flatListEntries, sortedEntries, viewMode]
  );
  const keyboardEntries =
    activeColumnContext?.activeEntries ??
    (viewMode === "list" ? flatListEntries : viewMode === "icon" ? flatGridEntries : sortedEntries);
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

  // 5. 文件操作（启用 RAW+JPG 配对时自动同步操作配对的伴随文件）
  const {
    handleOpen,
    handleCopy: rawHandleCopy,
    handleCut: rawHandleCut,
    handlePaste,
    handleDuplicate: rawHandleDuplicate,
    handleDelete: rawHandleDelete,
    handleCompress,
    handleExtract,
    handleGetInfo,
    handleRotateImage,
    handleShare,
    handleToggleFavorite,
    isFavorite,
    handleCopyPath,
    handleNewFile,
    handleNewFolder,
    handlePasteAsMove,
    handleOpenInTerminal,
    handleShowPackageContents,
    handleShowOriginal,
    handleToggleTag: rawHandleToggleTag,
    handleCopyTo: rawHandleCopyTo,
    handleMove: rawHandleMove,
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

  const expandPaths = useCallback(
    (sourcePaths: string | string[]) => {
      const list = Array.isArray(sourcePaths) ? sourcePaths : [sourcePaths];
      if (pairedCompanionsByPath.size === 0) return list;
      const expanded = new Set<string>(list);
      for (const path of list) {
        const companions = pairedCompanionsByPath.get(path);
        if (companions) {
          for (const companion of companions) expanded.add(companion.path);
        }
      }
      return Array.from(expanded);
    },
    [pairedCompanionsByPath]
  );

  const handleCopy = useCallback(
    (targets: FileEntry[]) => rawHandleCopy(expandPairedEntries(targets, pairedCompanionsByPath)),
    [pairedCompanionsByPath, rawHandleCopy]
  );
  const handleCut = useCallback(
    (targets: FileEntry[]) => rawHandleCut(expandPairedEntries(targets, pairedCompanionsByPath)),
    [pairedCompanionsByPath, rawHandleCut]
  );
  const handleDuplicate = useCallback(
    (targets: FileEntry[]) =>
      rawHandleDuplicate(expandPairedEntries(targets, pairedCompanionsByPath)),
    [pairedCompanionsByPath, rawHandleDuplicate]
  );
  const handleDelete = useCallback(
    (targets: FileEntry[]) => rawHandleDelete(expandPairedEntries(targets, pairedCompanionsByPath)),
    [pairedCompanionsByPath, rawHandleDelete]
  );
  const handleToggleTag = useCallback(
    (targets: FileEntry[], tag: string) =>
      rawHandleToggleTag(expandPairedEntries(targets, pairedCompanionsByPath), tag),
    [pairedCompanionsByPath, rawHandleToggleTag]
  );
  const handleMove = useCallback(
    (sourcePaths: string | string[], targetPath: string) =>
      rawHandleMove(expandPaths(sourcePaths), targetPath),
    [expandPaths, rawHandleMove]
  );
  const handleCopyTo = useCallback(
    (sourcePaths: string | string[], targetPath: string) =>
      rawHandleCopyTo(expandPaths(sourcePaths), targetPath),
    [expandPaths, rawHandleCopyTo]
  );

  // 6. 批量重命名
  const [batchRenameFiles, setBatchRenameFiles] = useState<FileEntry[]>([]);
  const [showBatchRename, setShowBatchRename] = useState(false);
  const [isFileDragOver, setIsFileDragOver] = useState(false);

  // 7. 快速预览
  const { quickLookEntry, setQuickLookEntry, useNativeQuickLook } = useQuickLook({
    selectedPath,
    editingPath,
    entries: keyboardEntries,
    forceCustomImagePreview: photoAnalysisEnabled,
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

  const handleFocusFilterBar = useCallback(() => {
    setFilterBarOpen(true);
    requestAnimationFrame(() => {
      filterInputRef.current?.focus();
      filterInputRef.current?.select();
    });
  }, []);

  const handleSetRatingBatch = useCallback(
    (targets: FileEntry[], rating: number) => {
      const expanded = expandPairedEntries(targets, pairedCompanionsByPath);
      void updatePhotoCullingStates(expanded.map((item) => ({ path: item.path, rating })));
    },
    [pairedCompanionsByPath]
  );

  const handleSetFlagBatch = useCallback(
    (targets: FileEntry[], flag: PhotoFlag) => {
      const expanded = expandPairedEntries(targets, pairedCompanionsByPath);
      void updatePhotoCullingStates(expanded.map((item) => ({ path: item.path, flag })));
    },
    [pairedCompanionsByPath]
  );

  const handleSetRating = useCallback(
    (target: FileEntry, rating: number) => handleSetRatingBatch([target], rating),
    [handleSetRatingBatch]
  );

  const handleSetFlag = useCallback(
    (target: FileEntry, flag: PhotoFlag) => handleSetFlagBatch([target], flag),
    [handleSetFlagBatch]
  );

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
    cullAutoAdvance,
    openEntry: handleOpen,
    onOpenParent: handleOpenParent,
    onGoBack: goBack,
    onGoForward: goForward,
    canGoBack,
    canGoForward,
    onToggleHiddenFiles: handleToggleHiddenFiles,
    onFocusFilterBar: handleFocusFilterBar,
    onToggleTag: handleToggleTag,
    onSetFlag: handleSetFlagBatch,
    onSetRating: handleSetRatingBatch,
    onScrollToIndex: (index) => scrollToIndexRef.current(index),
    onColumnNavigateLeft: () => columnNavRef.current?.navigateLeft() ?? false,
    onColumnNavigateRight: () => columnNavRef.current?.navigateRight() ?? Promise.resolve(false),
    onColumnFocusEntry: (entry) => columnNavRef.current?.focusEntry(entry) ?? Promise.resolve(),
    onListExpandDir: (entry) => {
      if (
        groupBy !== "none" ||
        !entry.is_dir ||
        (entry.is_package && entry.package_type === "app")
      ) {
        return;
      }
      if (!activeListTree.expanded[entry.path]) {
        handleToggleExpandDir(entry);
      } else {
        const idx = flatListEntries.findIndex((item) => item.path === entry.path);
        const next = idx >= 0 ? flatListEntries[idx + 1] : null;
        if (next && listParentPathByPath.get(next.path) === entry.path) {
          selectSingle(next.path, idx + 1);
          scrollToIndexRef.current(idx + 1);
        }
      }
    },
    onListCollapseDir: (entry) => {
      if (groupBy !== "none") return;
      if (entry.is_dir && activeListTree.expanded[entry.path]) {
        handleToggleExpandDir(entry);
        return;
      }
      const parentPath = listParentPathByPath.get(entry.path);
      if (parentPath) {
        const parentIdx = flatListEntries.findIndex((item) => item.path === parentPath);
        if (parentIdx >= 0) {
          selectSingle(parentPath, parentIdx);
          scrollToIndexRef.current(parentIdx);
        }
      }
    },
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
  const gridScrollRef = useRef<HTMLDivElement | null>(null);
  const [gridScrollEl, setGridScrollEl] = useState<HTMLDivElement | null>(null);
  const setGridScrollRef = useCallback((node: HTMLDivElement | null) => {
    gridScrollRef.current = node;
    setGridScrollEl((current) => (current === node ? current : node));
  }, []);
  const scrollPositionsRef = useRef<Record<string, number>>({});

  const getScrollContainer = useCallback((mode: typeof viewMode) => {
    if (mode === "list") return listScrollRef.current;
    if (mode === "icon") return gridScrollRef.current;
    return null;
  }, []);

  const gridItemWidth = Math.max(GRID_ITEM_MIN_WIDTH, iconSize + 16);
  const photoGridRowHeight = Math.max(212, iconSize + 104);
  // Reserve enough height for 2-line Finder-style folder labels without vertical clipping.
  const folderGridRowHeight = Math.max(GRID_ROW_HEIGHT + 16, Math.round(iconSize * 0.65) + 56);

  // 计算网格每行列数（绑定到实际挂载的滚动容器节点，避免初始 loading 阶段跳过 ResizeObserver 导致列数卡死）
  const updateGridColumns = useCallback(() => {
    const el = gridScrollEl ?? gridScrollRef.current;
    if (!el || el.clientWidth <= 0) return;
    const containerWidth = Math.max(0, el.clientWidth - 16); // p-2 padding
    const nextColumns = Math.max(
      1,
      Math.floor((containerWidth + GRID_GAP) / (gridItemWidth + GRID_GAP))
    );
    setGridColumns((current) => (current === nextColumns ? current : nextColumns));
  }, [gridItemWidth, gridScrollEl]);

  useEffect(() => {
    const el = gridScrollEl;
    if (!el) return;
    updateGridColumns();
    const observer = new ResizeObserver(updateGridColumns);
    observer.observe(el);
    return () => observer.disconnect();
  }, [gridScrollEl, updateGridColumns, viewMode]);

  // 列表虚拟化（支持分组标题与内联展开树）
  const listVirtualizer = useVirtualizer({
    count: listRows.length,
    getScrollElement: () => listScrollRef.current,
    estimateSize: (rowIndex) =>
      listRows[rowIndex]?.kind === "group" ? GROUP_HEADER_HEIGHT : LIST_ITEM_HEIGHT,
    overscan: 6,
    useAnimationFrameWithResizeObserver: true,
  });

  // 网格虚拟化（按行，支持分组标题）
  const gridVirtualizer = useVirtualizer({
    count: gridRows.length,
    getScrollElement: () => gridScrollRef.current,
    estimateSize: (rowIndex) => {
      const row = gridRows[rowIndex];
      if (!row) return folderGridRowHeight;
      if (row.kind === "group") return GROUP_HEADER_HEIGHT;
      if (!photoAnalysisEnabled) return folderGridRowHeight;
      for (const item of row.entries) {
        if (!item.is_dir) return photoGridRowHeight;
      }
      return folderGridRowHeight;
    },
    overscan: 2,
    useAnimationFrameWithResizeObserver: true,
  });
  useEffect(() => {
    listVirtualizer.measure();
  }, [groupBy, listVirtualizer]);
  useEffect(() => {
    gridVirtualizer.measure();
  }, [
    folderGridRowHeight,
    gridColumns,
    groupBy,
    photoAnalysisEnabled,
    photoGridRowHeight,
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

    const visible: FileEntry[] = [];
    const end = Math.min(gridRows.length - 1, gridViewportEndRow);
    for (let i = Math.max(0, gridViewportStartRow); i <= end; i += 1) {
      const row = gridRows[i];
      if (row?.kind === "entries") visible.push(...row.entries);
    }
    return visible;
  }, [gridRows, gridViewportEndRow, gridViewportStartRow, viewMode]);
  const gridViewportPaths = useMemo(
    () => gridViewportEntries.map((entry) => entry.path),
    [gridViewportEntries]
  );
  const gridViewportPathSet = useMemo(() => new Set(gridViewportPaths), [gridViewportPaths]);
  const listStart = listVirtualizer.range?.startIndex ?? 0;
  const listEnd = listVirtualizer.range?.endIndex ?? -1;
  const listViewportPaths = useMemo(() => {
    if (viewMode !== "list" || listEnd < listStart) return [];
    const visible: string[] = [];
    const end = Math.min(listRows.length - 1, listEnd);
    for (let i = Math.max(0, listStart); i <= end; i += 1) {
      const row = listRows[i];
      if (row?.kind === "entry") visible.push(row.entry.path);
    }
    return visible;
  }, [listEnd, listRows, listStart, viewMode]);
  const computedViewportPriorityPaths = viewMode === "icon" ? gridViewportPaths : listViewportPaths;
  // Sync visible paths via ref instead of setState so scrolling never triggers
  // a second full FileList re-render on every scroll frame.
  useEffect(() => {
    viewportPriorityPathsRef.current = computedViewportPriorityPaths;
  }, [computedViewportPriorityPaths]);

  useEffect(() => {
    setQuickLookOpenFlag(Boolean(quickLookEntry));
  }, [quickLookEntry]);

  const photoAnalysisEnabledForFolder = photoAnalysisEnabled;
  const { records: photoAnalysis } = usePhotoAnalysis(
    entries,
    photoAnalysisEnabledForFolder,
    currentPath,
    viewportPriorityPathsRef,
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
  const restoreSortedEntriesRef = useRef(sortedEntries);
  const restoreSelectedPathRef = useRef(selectedPath);
  const restoreGridColumnsRef = useRef(gridColumns);
  useEffect(() => {
    restoreSortedEntriesRef.current = sortedEntries;
    restoreSelectedPathRef.current = selectedPath;
    restoreGridColumnsRef.current = gridColumns;
  }, [gridColumns, selectedPath, sortedEntries]);

  useEffect(() => {
    const locationKey = `${viewMode}:${currentPath}`;
    if (loading || restoredViewRef.current === locationKey) return;
    if (viewMode === "column" || viewMode === "gallery") {
      restoredViewRef.current = locationKey;
      return;
    }
    restoredViewRef.current = locationKey;
    const frame = requestAnimationFrame(() => {
      const container = getScrollContainer(viewMode);
      if (!container) return;
      // Never override scroll position if the user already started scrolling down.
      if (container.scrollTop > 0) return;
      const targetSelected = restoreSelectedPathRef.current;
      const index = targetSelected
        ? restoreSortedEntriesRef.current.findIndex((entry) => entry.path === targetSelected)
        : -1;
      if (index >= 0) {
        if (viewMode === "list") {
          listVirtualizer.scrollToIndex(index, { align: "center" });
        } else {
          gridVirtualizer.scrollToIndex(
            Math.floor(index / Math.max(1, restoreGridColumnsRef.current)),
            {
              align: "center",
            }
          );
        }
      } else {
        const saved = scrollPositionsRef.current[locationKey] ?? 0;
        if (saved > 0) {
          container.scrollTop = saved;
        }
      }
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [currentPath, getScrollContainer, gridVirtualizer, listVirtualizer, loading, viewMode]);

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

  // 当前选中的文件集合与列表（O(k) Map 查找而非每次切选全表扫描）
  const selectionEntryByPath = useMemo(() => {
    const map = new Map<string, FileEntry>();
    for (const entry of selectionEntries) {
      map.set(entry.path, entry);
    }
    return map;
  }, [selectionEntries]);
  const sortedEntryIndexByPath = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < sortedEntries.length; i += 1) {
      map.set(sortedEntries[i].path, i);
    }
    return map;
  }, [sortedEntries]);
  const selectedPathSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const selectedFileEntries = useMemo(() => {
    const selected: FileEntry[] = [];
    for (const path of selectedPaths) {
      const entry = selectionEntryByPath.get(path);
      if (entry) selected.push(entry);
    }
    return selected;
  }, [selectedPaths, selectionEntryByPath]);

  useEffect(() => {
    scrollToIndexRef.current = (index: number) => {
      if (index < 0) return;
      if (viewMode === "list") {
        const entry = flatListEntries[index];
        const rowIdx = entry ? (listEntryRowIndexByPath.get(entry.path) ?? index) : index;
        listVirtualizer.scrollToIndex(rowIdx, { align: "auto" });
      } else if (viewMode === "icon") {
        const entry = flatGridEntries[index];
        const rowIdx = entry
          ? (gridRowIndexByPath.get(entry.path) ?? Math.floor(index / gridColumns))
          : Math.floor(index / gridColumns);
        gridVirtualizer.scrollToIndex(rowIdx, { align: "auto" });
      }
    };
  }, [
    flatGridEntries,
    flatListEntries,
    gridColumns,
    gridRowIndexByPath,
    gridVirtualizer,
    listEntryRowIndexByPath,
    listVirtualizer,
    viewMode,
  ]);

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

  const sortedEntriesRef = useRef(keyboardEntries);
  const selectedPathSetRef = useRef(selectedPathSet);
  const selectedPathsRef = useRef(selectedPaths);
  const selectionEntryByPathRef = useRef(selectionEntryByPath);
  useEffect(() => {
    sortedEntriesRef.current = keyboardEntries;
  }, [keyboardEntries]);
  useEffect(() => {
    selectedPathSetRef.current = selectedPathSet;
    selectedPathsRef.current = selectedPaths;
  }, [selectedPathSet, selectedPaths]);
  useEffect(() => {
    selectionEntryByPathRef.current = selectionEntryByPath;
  }, [selectionEntryByPath]);

  const delegatedDragHandlers = useMemo(
    () =>
      makeDelegatedFileDragGestureHandlers((entryPath) =>
        selectedPathSetRef.current.has(entryPath) ? selectedPathsRef.current : [entryPath]
      ),
    []
  );

  const handleContainerContextMenuCapture = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const itemElement = (event.target as Element | null)?.closest<HTMLElement>(
        "[data-entry-path]"
      );
      const path = itemElement?.dataset.entryPath;
      if (!path) {
        setContextMenuTarget(null);
        return;
      }
      setContextMenuTarget(selectionEntryByPathRef.current.get(path) ?? null);
    },
    []
  );

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
      onOpenInNewWindow: (entry) => {
        if (entry.is_dir) {
          void windowManager.createWindow({ path: entry.path }).catch((error) => {
            console.error("Failed to open folder in new window:", error);
          });
        }
      },
      onShowPackageContents: handleShowPackageContents,
      onShowOriginal: handleShowOriginal,
      onToggleTag: handleToggleTag,
      onCompare: (entriesToCompare) => setCompareEntries(entriesToCompare),
      onBatchExport: (photos) =>
        openBatchExport(photos, operationPath.startsWith(SMART_FOLDER_PREFIX) ? "" : operationPath),
      onExhibitLabelMode: (targets) => {
        if (targets.length === 1 && targets[0].is_dir) {
          openExhibitLabel(targets[0].path, []);
        } else if (!operationPath.startsWith(SMART_FOLDER_PREFIX)) {
          openExhibitLabel(operationPath, targets);
        }
      },
      onPeopleClusterMode: (targets) => {
        if (targets.length === 1 && targets[0].is_dir) {
          openPeopleCluster(targets[0].path, []);
        } else if (!operationPath.startsWith(SMART_FOLDER_PREFIX)) {
          openPeopleCluster(operationPath, targets);
        }
      },
      onExifSyncMode: (targets) => {
        if (targets.length === 1 && targets[0].is_dir) {
          openExifSync(targets[0].path, []);
        } else if (!operationPath.startsWith(SMART_FOLDER_PREFIX)) {
          openExifSync(operationPath, targets);
        }
      },
      onRotateImage: handleRotateImage,
      onShare: handleShare,
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
      handleRotateImage,
      handleShare,
      handleShowOriginal,
      handleShowPackageContents,
      handleStartRename,
      handleToggleFavorite,
      handleToggleTag,
      isFavorite,
      openBatchExport,
      openExhibitLabel,
      openExifSync,
      openPeopleCluster,
      operationPath,
    ]
  );

  // 连拍分组计数仅依赖 photoAnalysis（不再跟随每 160ms 的清晰度扫描全表重算）
  const burstGroupCount = useMemo(() => {
    if (photoAnalysis.size === 0) return 0;
    const groupCounts = new Map<number, number>();
    for (const record of photoAnalysis.values()) {
      if (record.groupId === null) continue;
      groupCounts.set(record.groupId, (groupCounts.get(record.groupId) ?? 0) + 1);
    }
    let groups = 0;
    for (const count of groupCounts.values()) {
      if (count >= 2) groups += 1;
    }
    return groups;
  }, [photoAnalysis]);

  const handleAutoPickBest = useCallback(() => {
    if (photoAnalysis.size === 0) return;
    const latestSharpness = getLatestSharpnessMap();
    const candidates = [];
    for (const [path, record] of photoAnalysis) {
      candidates.push({
        path,
        groupId: record.groupId,
        focusConfidence: record.focusAnalysis.confidence,
        focusKind: record.focusAnalysis.kind,
        sharpnessVerdict: latestSharpness.get(path),
      });
    }
    const plan = computeAutoPickBest(candidates);
    if (plan.groupCount === 0) return;
    const updates: Array<{ path: string; rating?: number; flag?: PhotoFlag }> = [];
    for (const path of plan.bestPaths) {
      updates.push({ path, flag: "pick", rating: 5 });
    }
    for (const path of plan.rejectedPaths) {
      updates.push({ path, flag: "reject" });
    }
    void updatePhotoCullingStates(updates).then(() => {
      alert(
        t("file_list.culling.auto_pick_best_done", {
          groups: plan.groupCount,
          best: plan.bestPaths.length,
          rejected: plan.rejectedPaths.length,
        })
      );
    });
  }, [photoAnalysis, t]);

  const quickLookCullingState = usePhotoCullingEntry(
    quickLookEntry?.path,
    Boolean(quickLookEntry) && !useNativeQuickLook
  );
  const handleCloseQuickLook = useCallback(() => setQuickLookEntry(null), [setQuickLookEntry]);
  const handleQuickLookToggleTag = useCallback(
    (target: FileEntry, tag: string) => void handleToggleTag([target], tag),
    [handleToggleTag]
  );
  const handleQuickLookDelete = useCallback(
    (target: FileEntry) => handleDelete([target]),
    [handleDelete]
  );
  const handleQuickLookExtract = useCallback(
    (target: FileEntry) => void handleExtract(target),
    [handleExtract]
  );
  const handleQuickLookNavigate = useCallback(
    (entry: FileEntry) => {
      const index = sortedEntryIndexByPath.get(entry.path) ?? -1;
      selectSingle(entry.path, index);
      if (index >= 0) {
        if (viewMode === "icon") {
          const rowIdx = gridRowIndexByPath.get(entry.path) ?? Math.floor(index / gridColumns);
          gridVirtualizer.scrollToIndex(rowIdx, { align: "auto" });
        } else if (viewMode === "list") {
          const rowIdx = listEntryRowIndexByPath.get(entry.path) ?? index;
          listVirtualizer.scrollToIndex(rowIdx, { align: "auto" });
        }
      }
      setQuickLookEntry(entry);
    },
    [
      gridColumns,
      gridRowIndexByPath,
      gridVirtualizer,
      listEntryRowIndexByPath,
      listVirtualizer,
      selectSingle,
      setQuickLookEntry,
      sortedEntryIndexByPath,
      viewMode,
    ]
  );

  const handleExportXmp = useCallback(async () => {
    const photoPaths = entries.filter(isAnalyzablePhoto).map((entry) => entry.path);
    if (photoPaths.length === 0) return;
    try {
      const count = await exportXmpSidecars(photoPaths);
      alert(
        count > 0
          ? t("file_list.culling.export_xmp_done", { count })
          : t("file_list.culling.export_xmp_empty")
      );
      if (count > 0) loadEntries(true);
    } catch (error) {
      alert(t("file_list.error_operation", { error: String(error) }));
    }
  }, [entries, loadEntries, t]);

  const handleExportFiltered = useCallback(async () => {
    const expanded = expandPairedEntries(filteredEntries, pairedCompanionsByPath);
    if (expanded.length === 0) return;
    const selectedDest = await openFileDialog({
      directory: true,
      multiple: false,
      defaultPath: currentPath.startsWith(SMART_FOLDER_PREFIX) ? undefined : currentPath,
    });
    if (typeof selectedDest !== "string" || !selectedDest) return;
    try {
      await enqueueFileOperation({
        kind: "copy",
        paths: expanded.map((entry) => entry.path),
        destDir: selectedDest,
      });
    } catch (error) {
      alert(t("file_list.error_operation", { error: String(error) }));
    }
  }, [currentPath, filteredEntries, pairedCompanionsByPath, t]);

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
        type={contextMenuTarget ? (contextMenuTarget.is_dir ? "folder" : "file") : "empty-area"}
        entry={contextMenuTarget ?? undefined}
        selectedEntries={contextMenuTarget ? selectedFileEntries : undefined}
        fileActions={contextMenuTarget ? fileActions : undefined}
        asChild
        emptyAreaActions={{
          onPaste: handlePaste,
          onRefresh: () => loadEntries(false, true),
          onNewFile: handleNewFile,
          onNewFolder: handleNewFolder,
          onOpenInTerminal: handleOpenInTerminal,
          onExhibitLabelMode: !currentPath.startsWith(SMART_FOLDER_PREFIX)
            ? () => openExhibitLabel(currentPath, [])
            : undefined,
          onPeopleClusterMode: !currentPath.startsWith(SMART_FOLDER_PREFIX)
            ? () => openPeopleCluster(currentPath, [])
            : undefined,
          onExifSyncMode: !currentPath.startsWith(SMART_FOLDER_PREFIX)
            ? () => openExifSync(currentPath, [])
            : undefined,
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
          className={`finder-files relative flex min-h-0 flex-1 flex-col overflow-hidden transition-colors ${
            isFileDragOver ? "ring-primary/30 ring-2 ring-inset" : ""
          }`}
          tabIndex={0}
          onContextMenuCapture={handleContainerContextMenuCapture}
          onDragOver={handleFileContainerDragOver}
          onDragLeave={handleFileContainerDragLeave}
          onDrop={handleFileContainerDrop}
        >
          <FolderSharpnessPanel
            key={currentPath}
            entries={folderScanEntries}
            enabled={!loading && !error}
            portalToTabBar={isPrimaryPane}
            onLocate={(entry) => {
              const parent = entry.path.slice(0, entry.path.lastIndexOf("/")) || "/";
              if (parent !== currentPath || viewMode === "column") {
                onNavigate(parent, entry.path);
                return;
              }

              // Resolve paired companion (e.g. JPG stacked under ARW) to its visible primary entry.
              let targetPath = entry.path;
              if (
                folderFilter.pairRawJpeg &&
                !sortedEntries.some((item) => item.path === targetPath)
              ) {
                for (const [primaryPath, companions] of pairedCompanionsByPath) {
                  if (companions.some((companion) => companion.path === entry.path)) {
                    targetPath = primaryPath;
                    break;
                  }
                }
              }

              const activeEntries =
                viewMode === "list"
                  ? flatListEntries
                  : viewMode === "icon"
                    ? flatGridEntries
                    : sortedEntries;
              const index = activeEntries.findIndex((item) => item.path === targetPath);

              if (index < 0) {
                // If an active folder filter hides this photo, reset filters and jump on next frame.
                if (hasActiveFolderFilter(folderFilter)) {
                  setFolderFilter((current) => ({
                    ...DEFAULT_FOLDER_FILTER,
                    pairRawJpeg: current.pairRawJpeg,
                  }));
                  onNavigate(currentPath, targetPath);
                }
                return;
              }

              selectSingle(targetPath, index);
              if (viewMode === "list") {
                const rowIdx = listEntryRowIndexByPath.get(targetPath) ?? index;
                listVirtualizer.scrollToIndex(rowIdx, { align: "center" });
              } else if (viewMode === "icon") {
                const rowIdx =
                  gridRowIndexByPath.get(targetPath) ??
                  Math.floor(index / Math.max(1, gridColumns));
                gridVirtualizer.scrollToIndex(rowIdx, { align: "center" });
              }
            }}
          />
          {isPrimaryPane &&
            tabBarStatusSlot &&
            !loading &&
            !error &&
            displayBaseEntries.length > 0 &&
            createPortal(
              <button
                type="button"
                aria-pressed={filterBarOpen}
                title={`${t("file_list.filter_toggle")} (⌘⌥F)`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={() => setFilterBarOpen((open) => !open)}
                className={`flex h-6 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[11px] leading-none transition-colors ${
                  filterBarOpen || hasActiveFolderFilter(folderFilter)
                    ? "border-primary/45 bg-primary/15 text-primary"
                    : "border-border/60 bg-muted/55 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
                }`}
              >
                <Filter className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span>{t("file_list.filter_toggle")}</span>
                {hasActiveFolderFilter(folderFilter) && (
                  <span className="font-mono text-[10px] tabular-nums">
                    {filteredEntries.length}/{displayBaseEntries.length}
                  </span>
                )}
              </button>,
              tabBarStatusSlot
            )}
          {filterBarOpen && (
            <div className={viewMode === "gallery" ? "shrink-0 px-3 pt-2" : "shrink-0"}>
              <FolderFilterBar
                filter={folderFilter}
                onChange={setFolderFilter}
                totalCount={displayBaseEntries.length}
                filteredCount={filteredEntries.length}
                pairCount={pairingPreview.pairCount}
                cameraOptions={cameraOptions}
                lensOptions={lensOptions}
                burstGroupCount={burstGroupCount}
                autoAdvance={cullAutoAdvance}
                onToggleAutoAdvance={toggleCullAutoAdvance}
                sortByCaptured={sortField === "captured"}
                onToggleSortByCaptured={() => handleSort("captured")}
                onAutoPickBest={handleAutoPickBest}
                onExportXmp={hasPhotosInFolder ? () => void handleExportXmp() : undefined}
                onBatchExport={
                  allPhotosInView.length > 0
                    ? () =>
                        openBatchExport(
                          allPhotosInView,
                          currentPath.startsWith(SMART_FOLDER_PREFIX) ? "" : currentPath
                        )
                    : undefined
                }
                onExportFiltered={() => void handleExportFiltered()}
                inputRef={filterInputRef}
                onClose={() => setFilterBarOpen(false)}
              />
            </div>
          )}
          {viewMode === "gallery" ? (
            <div className="min-h-0 flex-1 overflow-hidden">
              <FileGalleryView
                entries={sortedEntries}
                selectedPath={selectedPath}
                selectedPaths={selectedPaths}
                selectedFileEntries={selectedFileEntries}
                fileActions={fileActions}
                visibleSharpness={visibleSharpness}
                cullingMap={cullingMap}
                onSelect={(entry, index, event) => handleClick(entry, index, event)}
                onSelectSingle={selectSingle}
                onDoubleClick={handleOpen}
                onToggleTag={handleToggleTag}
                onSetRating={handleSetRating}
                onSetFlag={handleSetFlag}
                onCompare={(entriesToCompare) => setCompareEntries(entriesToCompare)}
              />
            </div>
          ) : viewMode === "column" ? (
            <div className="min-h-0 flex-1 overflow-hidden">
              <FileColumnView
                currentPath={currentPath}
                rootEntries={sortedEntries}
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
            </div>
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
                {...delegatedDragHandlers}
                className="finder-list-scroll relative min-h-0 flex-1 overflow-y-auto select-none"
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
                    const row = listRows[virtualItem.index];
                    if (!row) return null;
                    if (row.kind === "group") {
                      const collapsed = collapsedGroupSet.has(row.group.id);
                      const label = row.group.labelKey
                        ? t(row.group.labelKey)
                        : (row.group.rawLabel ?? row.group.id);
                      return (
                        <div
                          key={`group:${row.group.id}`}
                          data-index={virtualItem.index}
                          ref={listVirtualizer.measureElement}
                          style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            width: "100%",
                            height: `${GROUP_HEADER_HEIGHT}px`,
                            transform: `translateY(${virtualItem.start}px)`,
                          }}
                          className="border-border/50 bg-muted/40 flex items-center border-b px-2 text-xs font-medium"
                        >
                          <button
                            type="button"
                            onClick={() => toggleGroupCollapsed(row.group.id)}
                            className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 text-left"
                          >
                            {collapsed ? (
                              <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            ) : (
                              <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            )}
                            <span className="truncate">{label}</span>
                            <span className="text-muted-foreground/75 text-[11px] tabular-nums">
                              ({row.group.entries.length})
                            </span>
                          </button>
                        </div>
                      );
                    }

                    const { entry, flatIndex, depth, canExpand, isExpanded, isLoadingChildren } =
                      row;
                    const dropHandlers = makeDirectoryDropHandlers(
                      entry,
                      handleMove,
                      handleCopyTo,
                      false
                    );
                    const isEditing = editingPath === entry.path;
                    return (
                      <div
                        key={entry.path}
                        data-index={virtualItem.index}
                        data-entry-path={entry.path}
                        data-marquee-item="true"
                        data-marquee-path={entry.path}
                        draggable={false}
                        ref={listVirtualizer.measureElement}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          transform: `translateY(${virtualItem.start}px)`,
                        }}
                        {...dropHandlers}
                      >
                        <FileListItem
                          entry={entry}
                          index={flatIndex}
                          isInViewport={
                            virtualItem.index >= listStart && virtualItem.index <= listEnd
                          }
                          isScrolling={listVirtualizer.isScrolling}
                          isSelected={selectedPathSet.has(entry.path)}
                          isFocused={selectedPath === entry.path}
                          isEditing={isEditing}
                          editValue={isEditing ? editValue : ""}
                          onEditValueChange={setEditValue}
                          onSubmitRename={handleSubmitRename}
                          onCancelRename={handleCancelRename}
                          onItemClick={handleClick}
                          onItemNameClick={handleNameClick}
                          onItemDoubleClick={handleOpen}
                          columnWidths={listColumnWidths}
                          columnVisibility={listColumnVisibility}
                          pairedBadge={pairedCompanionsByPath.has(entry.path) ? "RAW+JPG" : null}
                          depth={depth}
                          canExpand={canExpand}
                          isExpanded={isExpanded}
                          isLoadingChildren={isLoadingChildren}
                          onToggleExpand={groupBy === "none" ? handleToggleExpandDir : undefined}
                        />
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
                ref={setGridScrollRef}
                onMouseDown={handleGridMarqueeMouseDown}
                {...delegatedDragHandlers}
                className="file-grid-scrollbar relative min-h-0 flex-1 overflow-y-scroll select-none"
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
                    const row = gridRows[virtualRow.index];
                    if (!row) return null;
                    if (row.kind === "group") {
                      const collapsed = collapsedGroupSet.has(row.group.id);
                      const label = row.group.labelKey
                        ? t(row.group.labelKey)
                        : (row.group.rawLabel ?? row.group.id);
                      return (
                        <div
                          key={`grid-group:${row.group.id}`}
                          data-index={virtualRow.index}
                          style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            width: "100%",
                            height: `${virtualRow.size}px`,
                            transform: `translateY(${virtualRow.start}px)`,
                          }}
                          className="border-border/50 bg-muted/35 flex items-center border-b px-3 text-xs font-medium"
                        >
                          <button
                            type="button"
                            onClick={() => toggleGroupCollapsed(row.group.id)}
                            className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 text-left"
                          >
                            {collapsed ? (
                              <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            ) : (
                              <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            )}
                            <span className="truncate">{label}</span>
                            <span className="text-muted-foreground/75 text-[11px] tabular-nums">
                              ({row.group.entries.length})
                            </span>
                          </button>
                        </div>
                      );
                    }

                    const cols = gridColumns;
                    const rowEntries = row.entries;
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
                            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                          }}
                        >
                          {rowEntries.map((entry, colIdx) => {
                            const globalIndex = row.startFlatIndex + colIdx;
                            const dropHandlers = makeDirectoryDropHandlers(
                              entry,
                              handleMove,
                              handleCopyTo,
                              true
                            );
                            const analysis = photoAnalysis.get(entry.path);
                            const isEditing = editingPath === entry.path;
                            return (
                              <div
                                key={entry.path}
                                data-entry-path={entry.path}
                                data-marquee-item="true"
                                data-marquee-path={entry.path}
                                draggable={false}
                                {...dropHandlers}
                              >
                                <FileGridItem
                                  entry={entry}
                                  index={globalIndex}
                                  isSelected={selectedPathSet.has(entry.path)}
                                  isFocused={selectedPath === entry.path}
                                  isEditing={isEditing}
                                  editValue={isEditing ? editValue : ""}
                                  onEditValueChange={setEditValue}
                                  onSubmitRename={handleSubmitRename}
                                  onCancelRename={handleCancelRename}
                                  onItemClick={handleClick}
                                  onItemNameClick={handleNameClick}
                                  onItemDoubleClick={handleOpen}
                                  photoAnalysis={analysis}
                                  photoAnalysisEnabled={photoAnalysisEnabled}
                                  iconSize={iconSize}
                                  pairedBadge={
                                    pairedCompanionsByPath.has(entry.path) ? "RAW+JPG" : null
                                  }
                                  isScrolling={gridIsScrolling}
                                  isInViewport={gridViewportPathSet.has(entry.path)}
                                  photoGroupColor={getPhotoGroupColor(analysis?.groupId ?? null)}
                                />
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
          entryAnalysis={quickLookEntry ? photoAnalysis.get(quickLookEntry.path) : undefined}
          cullingState={quickLookCullingState}
          autoAdvance={cullAutoAdvance}
          onClose={handleCloseQuickLook}
          onToggleTag={handleQuickLookToggleTag}
          onSetRating={handleSetRating}
          onSetFlag={handleSetFlag}
          onDelete={handleQuickLookDelete}
          onExtract={handleQuickLookExtract}
          onNavigate={handleQuickLookNavigate}
        />
      )}

      {compareEntries && (
        <Suspense fallback={null}>
          <PhotoCompareDialog
            entries={compareEntries}
            allPhotos={allPhotosInView}
            visibleSharpness={visibleSharpness}
            cullingMap={cullingMap}
            onClose={() => setCompareEntries(null)}
            onToggleTag={(target, tag) => void handleToggleTag([target], tag)}
            onSetRating={handleSetRating}
            onSetFlag={handleSetFlag}
            onDelete={(target) => handleDelete([target])}
          />
        </Suspense>
      )}

      {showBatchRename && (
        <Suspense fallback={null}>
          <BatchRenameDialog
            open={showBatchRename}
            onOpenChange={setShowBatchRename}
            selectedFiles={batchRenameFiles}
            onComplete={() => loadEntries(false)}
          />
        </Suspense>
      )}
    </>
  );
}

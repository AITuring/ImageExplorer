import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { SettingsDialog } from "@/components/SettingsDialog";
import {
  Image,
  FileText,
  Folder,
  ChevronRight,
  ChevronDown,
  Home,
  Download,
  Music,
  Settings,
  HardDrive,
  Trash2,
  Star,
  Clock3,
  X,
  LogOut,
  Loader2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { AppContextMenu } from "@/components/AppContextMenu";
import { SmartIcon } from "@/components/SmartIcon";
import { filterHiddenEntries } from "@/utils/file";
import { useSetting } from "@/hooks/useSetting";
import { useTrashDialog } from "@/stores/trashDialog";
import { getLocationName, useLocations } from "@/stores/locations";
import { FINDER_TAG_PRESETS } from "@/lib/finderTags";
import { SMART_FOLDER_PREFIX } from "@/constants/config";
import {
  hasFileDragPayload,
  resolveExecutableDrop,
  resolveFileDragData,
  resolveFileDropEffect,
} from "@/lib/dragData";
import { makeNativeFileDragGestureHandlers } from "@/lib/nativeFileDragGesture";
import { enqueueFileOperation } from "@/lib/fileOperations";
import { windowManager } from "@/lib/windowManager";
import { useTabs } from "@/hooks/useTabs";

import { FileEntry, FolderItem, MountedVolume, SidebarItemActions } from "@/types";

interface SidebarProps {
  currentPath: string;
  onNavigate: (path: string) => void;
}

const SIDEBAR_DEFAULT_WIDTH = 240;
const SIDEBAR_MIN_WIDTH = 168;
const SIDEBAR_COLLAPSE_THRESHOLD = 96;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_KEYBOARD_STEP = 16;

function clampSidebarWidth(width: number) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

interface SidebarFolderDropProps {
  dropTargetPath: string | null;
  onDragOverTarget: (event: React.DragEvent, targetPath: string) => void;
  onDragLeaveTarget: (event: React.DragEvent, targetPath: string) => void;
  onDropOnTarget: (event: React.DragEvent, targetPath: string) => void;
}

function isDroppableSidebarPath(path: string): boolean {
  return path.length > 0 && !path.startsWith(SMART_FOLDER_PREFIX);
}

const SIDEBAR_DROP_HIGHLIGHT_CLASS = "bg-primary/15 ring-1 ring-primary/50";

function openPathInNewWindow(path: string) {
  void windowManager.createWindow({ path }).catch((error) => {
    console.error("Failed to open folder in new window:", error);
  });
}

function handleSidebarItemClick(
  event: React.MouseEvent,
  path: string,
  onNavigate: (path: string) => void,
  onOpenInNewTab: (path: string) => void
) {
  if (event.metaKey || event.ctrlKey) {
    event.preventDefault();
    if (event.shiftKey) {
      openPathInNewWindow(path);
    } else {
      onOpenInNewTab(path);
    }
    return;
  }
  onNavigate(path);
}

function SidebarLocationRow({
  path,
  active,
  icon: Icon,
  onNavigate,
  onOpenInNewTab,
  onToggleFavorite,
  isFavorite,
  onRemoveRecent,
  onRemove,
  dropProps,
}: {
  path: string;
  active: boolean;
  icon: typeof Star;
  onNavigate: (path: string) => void;
  onOpenInNewTab: (path: string) => void;
  onToggleFavorite?: () => void;
  isFavorite?: boolean;
  onRemoveRecent?: () => void;
  onRemove?: () => void;
  dropProps: SidebarFolderDropProps;
}) {
  const { t } = useTranslation();
  const label = getLocationName(path);
  const isDropTarget = dropProps.dropTargetPath === path;
  const sidebarItemActions: SidebarItemActions = {
    onOpen: () => onNavigate(path),
    onOpenInNewTab: () => onOpenInNewTab(path),
    onOpenInNewWindow: () => openPathInNewWindow(path),
    onOpenInTerminal: () => invoke("open_in_terminal", { path }),
    path,
    name: label,
    onToggleFavorite,
    isFavorite,
    onRemoveRecent,
  };

  const nativeDragHandlers = isDroppableSidebarPath(path)
    ? makeNativeFileDragGestureHandlers([path], { allowButtonTarget: true })
    : undefined;

  return (
    <AppContextMenu type="sidebar-item" sidebarItemActions={sidebarItemActions} asChild>
      <div
        className={`finder-sidebar-row group flex min-w-0 items-center ${
          isDropTarget ? SIDEBAR_DROP_HIGHLIGHT_CLASS : ""
        }`}
        data-active={active}
        {...nativeDragHandlers}
        onDragOver={(e) => dropProps.onDragOverTarget(e, path)}
        onDragLeave={(e) => dropProps.onDragLeaveTarget(e, path)}
        onDrop={(e) => dropProps.onDropOnTarget(e, path)}
      >
        <button
          className="flex min-h-[29px] min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1 text-left text-[13px]"
          aria-current={active ? "page" : undefined}
          onClick={(e) => handleSidebarItemClick(e, path, onNavigate, onOpenInNewTab)}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              onOpenInNewTab(path);
            }
          }}
          title={path}
        >
          <Icon
            className="finder-sidebar-icon h-[15px] w-[15px] shrink-0 opacity-90"
            aria-hidden="true"
          />
          <span className="truncate">{label}</span>
        </button>
        {onRemove && (
          <button
            className="text-muted-foreground hover:text-foreground mr-1.5 rounded-full p-1 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
            onClick={onRemove}
            aria-label={t("sidebar.remove_item", { name: label })}
            title={t("sidebar.remove_item", { name: label })}
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        )}
      </div>
    </AppContextMenu>
  );
}

const getQuickAccess = (t: (key: string) => string, home: string) => {
  return [
    {
      name: t("sidebar.items.home"),
      icon: Home,
      path: home,
      sysIcon: { type: "path" as const, value: home },
    },
    {
      name: t("sidebar.items.downloads"),
      icon: Download,
      path: `${home}/Downloads`,
      sysIcon: { type: "path" as const, value: `${home}/Downloads` },
    },
    {
      name: t("sidebar.items.documents"),
      icon: FileText,
      path: `${home}/Documents`,
      sysIcon: { type: "path" as const, value: `${home}/Documents` },
    },
    {
      name: t("sidebar.items.music"),
      icon: Music,
      path: `${home}/Music`,
      sysIcon: { type: "path" as const, value: `${home}/Music` },
    },
    {
      name: t("sidebar.items.desktop"),
      icon: Image,
      path: `${home}/Desktop`,
      sysIcon: { type: "path" as const, value: `${home}/Desktop` },
    },
  ];
};

function FolderTreeItem({
  item,
  currentPath,
  level = 0,
  onNavigate,
  onOpenInNewTab,
  showHiddenFiles,
  hiddenPaths,
  onHide,
  dropProps,
}: {
  item: FolderItem;
  currentPath: string;
  level?: number;
  onNavigate: (path: string) => void;
  onOpenInNewTab: (path: string) => void;
  showHiddenFiles: boolean;
  hiddenPaths: string[];
  onHide: (path: string) => void;
  dropProps: SidebarFolderDropProps;
}) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);
  const [children, setChildren] = useState<FolderItem[]>(item.children || []);
  const [hasLoaded, setHasLoaded] = useState(!!item.children);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);

  // 如果没有预设子项，默认为有子项（显示箭头），直到加载后确认
  const hasChildren = children.length > 0 || !hasLoaded;

  // 刷新子目录列表
  const refreshChildren = useCallback(async () => {
    try {
      const entries = await invoke<FileEntry[]>("get_entries", {
        path: item.path,
        forceRefresh: false,
      });
      const subDirs = filterHiddenEntries(entries, showHiddenFiles)
        .filter((e) => e.is_dir)
        .map((e) => ({ name: e.name, path: e.path }));
      setChildren(subDirs);
    } catch {
      // 静默失败
    }
  }, [item.path, showHiddenFiles]);

  // 展开时监听目录变化，折叠时取消监听
  useEffect(() => {
    if (!isExpanded || !hasLoaded) return;

    let unlistenFn: (() => void) | null = null;
    let cancelled = false;

    const setup = async () => {
      // 注册监听
      invoke("watch_directory", { path: item.path }).catch(() => {});

      unlistenFn = await listen<string>("dir-change", (event) => {
        if (!cancelled && event.payload === item.path) {
          refreshChildren();
        }
      });
    };
    setup();

    return () => {
      cancelled = true;
      unlistenFn?.();
      invoke("unwatch_directory", { path: item.path }).catch(() => {});
    };
  }, [isExpanded, hasLoaded, item.path, refreshChildren]);

  // 显示偏好变化时重新过滤已加载的目录树，避免必须折叠再展开。
  useEffect(() => {
    if (hasLoaded) {
      refreshChildren();
    }
  }, [hasLoaded, refreshChildren, showHiddenFiles]);

  const handleToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();

    if (isExpanded) {
      setIsExpanded(false);
      return;
    }

    setIsExpanded(true);

    if (!hasLoaded) {
      setIsLoading(true);
      try {
        const entries = await invoke<FileEntry[]>("get_entries", {
          path: item.path,
          forceRefresh: false,
        });
        const subDirs = filterHiddenEntries(entries, showHiddenFiles)
          .filter((e) => e.is_dir)
          .map((e) => ({ name: e.name, path: e.path }));

        setChildren(subDirs);
        setLoadError(false);
      } catch {
        setChildren([]);
        setLoadError(true);
      } finally {
        setHasLoaded(true);
        setIsLoading(false);
      }
    }
  };

  const sidebarItemActions: SidebarItemActions = {
    onOpen: () => onNavigate(item.path),
    onOpenInNewTab: () => onOpenInNewTab(item.path),
    onOpenInNewWindow: () => openPathInNewWindow(item.path),
    onOpenInTerminal: () => invoke("open_in_terminal", { path: item.path }),
    path: item.path,
    name: item.name,
    onRemoveFromSidebar: () => onHide(item.path),
  };

  const isDropTarget = dropProps.dropTargetPath === item.path;
  const nativeDragHandlers = isDroppableSidebarPath(item.path)
    ? makeNativeFileDragGestureHandlers([item.path], { allowButtonTarget: true })
    : undefined;

  return (
    <div>
      <AppContextMenu type="sidebar-item" sidebarItemActions={sidebarItemActions}>
        <button
          className={`finder-sidebar-row flex w-full items-center gap-2 px-2.5 py-1 text-[13px] ${
            isDropTarget ? SIDEBAR_DROP_HIGHLIGHT_CLASS : ""
          }`}
          aria-current={currentPath === item.path ? "page" : undefined}
          data-active={currentPath === item.path}
          style={{ paddingLeft: `${level * 12 + 8}px` }}
          {...nativeDragHandlers}
          onClick={(e) => handleSidebarItemClick(e, item.path, onNavigate, onOpenInNewTab)}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              onOpenInNewTab(item.path);
            }
          }}
          onDragOver={(e) => dropProps.onDragOverTarget(e, item.path)}
          onDragLeave={(e) => dropProps.onDragLeaveTarget(e, item.path)}
          onDrop={(e) => dropProps.onDropOnTarget(e, item.path)}
        >
          {/* 展开/折叠箭头 */}
          <div
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm hover:bg-black/5 dark:hover:bg-white/10"
            onClick={handleToggle}
          >
            {isLoading ? (
              <div className="text-muted-foreground h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : hasChildren ? (
              isExpanded ? (
                <ChevronDown className="text-muted-foreground h-3 w-3" />
              ) : (
                <ChevronRight className="text-muted-foreground h-3 w-3" />
              )
            ) : (
              <span className="w-3" />
            )}
          </div>

          <SmartIcon
            icon={Folder}
            className="h-4 w-4 shrink-0 text-blue-500"
            sysIcon={{ type: "path", value: item.path }}
          />
          <span className="truncate">{item.name}</span>
        </button>
      </AppContextMenu>

      {isExpanded && loadError && (
        <div
          className="text-muted-foreground truncate text-xs italic"
          style={{ paddingLeft: `${(level + 1) * 12 + 28}px` }}
        >
          {t("sidebar.access_denied")}
        </div>
      )}
      {isExpanded &&
        !loadError &&
        children
          .filter((child) => !hiddenPaths.includes(child.path))
          .map((child) => (
            <FolderTreeItem
              key={child.path}
              item={child}
              currentPath={currentPath}
              level={level + 1}
              onNavigate={onNavigate}
              onOpenInNewTab={onOpenInNewTab}
              showHiddenFiles={showHiddenFiles}
              hiddenPaths={hiddenPaths}
              onHide={onHide}
              dropProps={dropProps}
            />
          ))}
    </div>
  );
}

export function Sidebar({ onNavigate, currentPath }: SidebarProps) {
  const { t } = useTranslation();
  const { addTab } = useTabs();
  const handleOpenInNewTab = useCallback((path: string) => addTab(path), [addTab]);
  const setTrashOpen = useTrashDialog((state) => state.setOpen);
  const favorites = useLocations((state) => state.favorites);
  const recentLocations = useLocations((state) => state.recentLocations);
  const hiddenSidebarPaths = useLocations((state) => state.hiddenSidebarPaths);
  const toggleFavorite = useLocations((state) => state.toggleFavorite);
  const removeRecentLocation = useLocations((state) => state.removeRecentLocation);
  const hideSidebarPath = useLocations((state) => state.hideSidebarPath);
  const restoreSidebarPaths = useLocations((state) => state.restoreSidebarPaths);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [home, setHome] = useState<string>("");
  const [mountedVolumes, setMountedVolumes] = useState<MountedVolume[]>([]);
  const [ejectingVolumePath, setEjectingVolumePath] = useState<string | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);

  const handleDragOverTarget = useCallback((event: React.DragEvent, targetPath: string) => {
    if (!isDroppableSidebarPath(targetPath) || !hasFileDragPayload(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = resolveFileDropEffect(event.dataTransfer, targetPath, {
      altKey: event.altKey,
      metaKey: event.metaKey,
    });
    setDropTargetPath((current) => (current === targetPath ? current : targetPath));
  }, []);

  const handleDragLeaveTarget = useCallback((event: React.DragEvent, targetPath: string) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node)) {
      setDropTargetPath((current) => (current === targetPath ? null : current));
    }
  }, []);

  const handleDropOnTarget = useCallback((event: React.DragEvent, targetPath: string) => {
    if (!isDroppableSidebarPath(targetPath) || !hasFileDragPayload(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setDropTargetPath(null);

    const modifiers = { altKey: event.altKey, metaKey: event.metaKey };
    void resolveFileDragData(event.dataTransfer).then((data) => {
      if (!data) return;
      const resolved = resolveExecutableDrop(data.paths, targetPath, modifiers);
      if (!resolved) return;

      void enqueueFileOperation({
        kind: resolved.operation,
        paths: resolved.paths,
        destDir: targetPath,
      }).catch((error) => {
        console.error("Failed to drop files onto sidebar folder:", error);
      });
    });
  }, []);

  const folderDropProps = useMemo<SidebarFolderDropProps>(
    () => ({
      dropTargetPath,
      onDragOverTarget: handleDragOverTarget,
      onDragLeaveTarget: handleDragLeaveTarget,
      onDropOnTarget: handleDropOnTarget,
    }),
    [dropTargetPath, handleDragLeaveTarget, handleDragOverTarget, handleDropOnTarget]
  );

  const handleEjectVolume = useCallback(
    async (volume: MountedVolume) => {
      setEjectingVolumePath(volume.path);
      try {
        await invoke("eject_volume", { path: volume.path });
        if (currentPath === volume.path || currentPath.startsWith(`${volume.path}/`)) {
          onNavigate(home || "/");
        }
        const refreshed = await invoke<MountedVolume[]>("get_mounted_volumes");
        setMountedVolumes(refreshed);
      } catch (error) {
        alert(t("sidebar.eject_failed", { name: volume.name, error: String(error) }));
      } finally {
        setEjectingVolumePath((current) => (current === volume.path ? null : current));
      }
    },
    [currentPath, home, onNavigate, t]
  );
  const [showHiddenFiles] = useSetting<boolean>("show_hidden_files", false);
  const [storedSidebarWidth, setStoredSidebarWidth] = useSetting<number>(
    "sidebar_width",
    SIDEBAR_DEFAULT_WIDTH
  );
  const [storedSidebarCollapsed, setStoredSidebarCollapsed] = useSetting<boolean>(
    "sidebar_collapsed",
    false
  );
  const [draftSidebarWidth, setDraftSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [draftSidebarCollapsed, setDraftSidebarCollapsed] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const isSidebarCollapsed = isResizing ? draftSidebarCollapsed : storedSidebarCollapsed;
  const sidebarWidth = isSidebarCollapsed
    ? 0
    : isResizing
      ? draftSidebarWidth
      : clampSidebarWidth(storedSidebarWidth);
  const resizeStartRef = useRef({ x: 0, width: 0, wasCollapsed: false });
  const draftSidebarWidthRef = useRef(draftSidebarWidth);
  const draftSidebarCollapsedRef = useRef(draftSidebarCollapsed);
  const expandedSidebarWidthRef = useRef(clampSidebarWidth(storedSidebarWidth));

  useEffect(() => {
    if (!isResizing) {
      expandedSidebarWidthRef.current = clampSidebarWidth(storedSidebarWidth);
    }
  }, [isResizing, storedSidebarWidth]);

  const persistSidebarState = useCallback(
    (width: number, collapsed: boolean) => {
      const nextWidth = clampSidebarWidth(width);
      if (!collapsed) {
        expandedSidebarWidthRef.current = nextWidth;
      }
      draftSidebarWidthRef.current = nextWidth;
      draftSidebarCollapsedRef.current = collapsed;
      setDraftSidebarWidth(nextWidth);
      setDraftSidebarCollapsed(collapsed);
      void setStoredSidebarWidth(collapsed ? expandedSidebarWidthRef.current : nextWidth);
      void setStoredSidebarCollapsed(collapsed);
    },
    [setStoredSidebarCollapsed, setStoredSidebarWidth]
  );

  const handleResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const wasCollapsed = isSidebarCollapsed;
      const startWidth = wasCollapsed ? 0 : sidebarWidth;
      if (!wasCollapsed) {
        expandedSidebarWidthRef.current = sidebarWidth;
      }
      resizeStartRef.current = { x: event.clientX, width: startWidth, wasCollapsed };
      draftSidebarWidthRef.current = startWidth;
      draftSidebarCollapsedRef.current = wasCollapsed;
      setDraftSidebarWidth(startWidth);
      setDraftSidebarCollapsed(wasCollapsed);
      setIsResizing(true);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [isSidebarCollapsed, sidebarWidth]
  );

  useEffect(() => {
    if (!isResizing) return;

    const handlePointerMove = (event: PointerEvent) => {
      const { x, width: startWidth, wasCollapsed } = resizeStartRef.current;
      const rawWidth = wasCollapsed ? event.clientX - x : startWidth + event.clientX - x;
      const nextCollapsed = wasCollapsed
        ? rawWidth < SIDEBAR_MIN_WIDTH
        : rawWidth <= SIDEBAR_COLLAPSE_THRESHOLD;
      const nextWidth = clampSidebarWidth(rawWidth);

      if (!nextCollapsed) {
        expandedSidebarWidthRef.current = nextWidth;
      }
      draftSidebarWidthRef.current = nextWidth;
      draftSidebarCollapsedRef.current = nextCollapsed;
      setDraftSidebarWidth(nextWidth);
      setDraftSidebarCollapsed(nextCollapsed);
    };
    const handlePointerUp = () => {
      setIsResizing(false);
      const collapsed = draftSidebarCollapsedRef.current;
      void setStoredSidebarWidth(
        collapsed ? expandedSidebarWidthRef.current : draftSidebarWidthRef.current
      );
      void setStoredSidebarCollapsed(collapsed);
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp);
    document.addEventListener("pointercancel", handlePointerUp);

    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
      document.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [isResizing, setStoredSidebarCollapsed, setStoredSidebarWidth]);

  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (isSidebarCollapsed) {
        if (event.key !== "ArrowRight" && event.key !== "End") return;
        event.preventDefault();
        persistSidebarState(SIDEBAR_MIN_WIDTH, false);
        return;
      }

      let nextWidth: number;
      if (event.key === "ArrowLeft") {
        nextWidth = sidebarWidth - SIDEBAR_KEYBOARD_STEP;
      } else if (event.key === "ArrowRight") {
        nextWidth = sidebarWidth + SIDEBAR_KEYBOARD_STEP;
      } else if (event.key === "Home") {
        nextWidth = SIDEBAR_MIN_WIDTH;
      } else if (event.key === "End") {
        nextWidth = SIDEBAR_MAX_WIDTH;
      } else {
        return;
      }

      event.preventDefault();
      persistSidebarState(nextWidth, nextWidth < SIDEBAR_MIN_WIDTH);
    },
    [isSidebarCollapsed, persistSidebarState, sidebarWidth]
  );

  useEffect(() => {
    invoke<string>("get_home_dir").then(setHome).catch(console.error);
  }, []);

  // Finder 的“位置”由 macOS NSWorkspace 卷挂载/卸载通知实时推送更新，
  // 并在窗口重新聚焦时做兜底同步，彻底消除每 3 秒一次的后台轮询唤醒。
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const refreshMountedVolumes = async () => {
      try {
        const volumes = await invoke<MountedVolume[]>("get_mounted_volumes");
        if (!cancelled) setMountedVolumes(volumes);
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to load mounted volumes:", error);
          setMountedVolumes([]);
        }
      }
    };

    void refreshMountedVolumes();
    window.addEventListener("focus", refreshMountedVolumes);
    void listen("volumes-changed", () => void refreshMountedVolumes())
      .then((dispose) => {
        if (cancelled) {
          dispose();
        } else {
          unlisten = dispose;
        }
      })
      .catch((error) => console.error("Failed to listen for volume events:", error));

    return () => {
      cancelled = true;
      window.removeEventListener("focus", refreshMountedVolumes);
      unlisten?.();
    };
  }, []);

  const quickAccess = useMemo(() => getQuickAccess(t, home), [t, home]);
  const visibleFavorites = favorites.filter((path) => !hiddenSidebarPaths.includes(path));
  const visibleRecentLocations = recentLocations.filter(
    (path) => !favorites.includes(path) && !hiddenSidebarPaths.includes(path)
  );

  const folderTree: FolderItem[] = [
    {
      name: t("sidebar.items.documents"),
      path: `${home}/Documents`,
    },
    {
      name: t("sidebar.items.downloads"),
      path: `${home}/Downloads`,
    },
    {
      name: t("sidebar.items.desktop"),
      path: `${home}/Desktop`,
    },
  ];

  return (
    <aside
      data-collapsed={isSidebarCollapsed}
      className={`finder-sidebar relative z-30 flex min-h-0 shrink-0 flex-col ${
        isResizing ? "" : "transition-[width] duration-150 ease-out"
      }`}
      style={{ width: `${sidebarWidth}px` }}
      onMouseDown={(event) => {
        if ((event.target as Element | null)?.closest("button")) {
          event.preventDefault();
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="finder-sidebar-header" data-tauri-drag-region />

      <div className="finder-sidebar-scroll flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto">
        {/* 快速访问 */}
        <section>
          <h3 className="finder-sidebar-section-title">{t("sidebar.quick_access")}</h3>
          <div className="space-y-0.5">
            {quickAccess
              .filter((item) => !hiddenSidebarPaths.includes(item.path))
              .map((item) => {
                const sidebarItemActions: SidebarItemActions = {
                  onOpen: () => onNavigate(item.path),
                  onOpenInNewTab: () => handleOpenInNewTab(item.path),
                  onOpenInNewWindow: () => openPathInNewWindow(item.path),
                  onOpenInTerminal: () => invoke("open_in_terminal", { path: item.path }),
                  path: item.path,
                  name: item.name,
                  onRemoveFromSidebar: () => void hideSidebarPath(item.path),
                };
                return (
                  <AppContextMenu
                    key={item.path}
                    type="sidebar-item"
                    sidebarItemActions={sidebarItemActions}
                  >
                    <button
                      className={`finder-sidebar-row flex w-full items-center gap-2.5 px-2.5 py-1 text-[13px] ${
                        dropTargetPath === item.path ? SIDEBAR_DROP_HIGHLIGHT_CLASS : ""
                      }`}
                      aria-current={currentPath === item.path ? "page" : undefined}
                      data-active={currentPath === item.path}
                      {...(isDroppableSidebarPath(item.path)
                        ? makeNativeFileDragGestureHandlers([item.path], {
                            allowButtonTarget: true,
                          })
                        : {})}
                      onClick={(e) =>
                        handleSidebarItemClick(e, item.path, onNavigate, handleOpenInNewTab)
                      }
                      onAuxClick={(e) => {
                        if (e.button === 1) {
                          e.preventDefault();
                          handleOpenInNewTab(item.path);
                        }
                      }}
                      onDragOver={(e) => handleDragOverTarget(e, item.path)}
                      onDragLeave={(e) => handleDragLeaveTarget(e, item.path)}
                      onDrop={(e) => handleDropOnTarget(e, item.path)}
                    >
                      <item.icon
                        className="finder-sidebar-icon h-[15px] w-[15px] shrink-0"
                        aria-hidden="true"
                      />
                      <span className="truncate">{item.name}</span>
                    </button>
                  </AppContextMenu>
                );
              })}
          </div>
        </section>

        {visibleFavorites.length > 0 && (
          <section aria-labelledby="sidebar-favorites-heading">
            <h3 id="sidebar-favorites-heading" className="finder-sidebar-section-title">
              {t("sidebar.favorites")}
            </h3>
            <div className="space-y-0.5">
              {visibleFavorites.map((path) => (
                <SidebarLocationRow
                  key={`favorite:${path}`}
                  path={path}
                  active={currentPath === path}
                  icon={Star}
                  onNavigate={onNavigate}
                  onOpenInNewTab={handleOpenInNewTab}
                  isFavorite
                  onToggleFavorite={() => void toggleFavorite(path)}
                  onRemove={() => void toggleFavorite(path)}
                  dropProps={folderDropProps}
                />
              ))}
            </div>
          </section>
        )}

        {visibleRecentLocations.length > 0 && (
          <section aria-labelledby="sidebar-recent-heading">
            <h3 id="sidebar-recent-heading" className="finder-sidebar-section-title">
              {t("sidebar.recent")}
            </h3>
            <div className="space-y-0.5">
              {visibleRecentLocations.map((path) => (
                <SidebarLocationRow
                  key={`recent:${path}`}
                  path={path}
                  active={currentPath === path}
                  icon={Clock3}
                  onNavigate={onNavigate}
                  onOpenInNewTab={handleOpenInNewTab}
                  onRemoveRecent={() => void removeRecentLocation(path)}
                  onRemove={() => void removeRecentLocation(path)}
                  dropProps={folderDropProps}
                />
              ))}
            </div>
          </section>
        )}

        {/* 文件夹树 */}
        <section>
          <h3 className="finder-sidebar-section-title">{t("sidebar.folders")}</h3>
          <div className="w-max min-w-full space-y-0.5">
            {folderTree
              .filter((item) => !hiddenSidebarPaths.includes(item.path))
              .map((item) => (
                <FolderTreeItem
                  key={item.path}
                  item={item}
                  currentPath={currentPath}
                  onNavigate={onNavigate}
                  onOpenInNewTab={handleOpenInNewTab}
                  showHiddenFiles={showHiddenFiles}
                  hiddenPaths={hiddenSidebarPaths}
                  onHide={(path) => void hideSidebarPath(path)}
                  dropProps={folderDropProps}
                />
              ))}
          </div>
        </section>

        {mountedVolumes.length > 0 && (
          <section>
            <h3 className="finder-sidebar-section-title">{t("sidebar.locations")}</h3>
            <div className="space-y-0.5">
              {mountedVolumes
                .filter((volume) => !hiddenSidebarPaths.includes(volume.path))
                .map((volume) => {
                  const isEjecting = ejectingVolumePath === volume.path;
                  const sidebarItemActions: SidebarItemActions = {
                    onOpen: () => onNavigate(volume.path),
                    onOpenInNewTab: () => handleOpenInNewTab(volume.path),
                    onOpenInNewWindow: () => openPathInNewWindow(volume.path),
                    onOpenInTerminal: () => invoke("open_in_terminal", { path: volume.path }),
                    path: volume.path,
                    name: volume.name,
                    onEject: () => void handleEjectVolume(volume),
                    onRemoveFromSidebar: () => void hideSidebarPath(volume.path),
                  };

                  return (
                    <AppContextMenu
                      key={volume.path}
                      type="sidebar-item"
                      sidebarItemActions={sidebarItemActions}
                    >
                      <div
                        className={`finder-sidebar-row group flex items-center gap-0.5 ${
                          dropTargetPath === volume.path ? SIDEBAR_DROP_HIGHLIGHT_CLASS : ""
                        }`}
                        data-active={currentPath === volume.path}
                        {...(isDroppableSidebarPath(volume.path)
                          ? makeNativeFileDragGestureHandlers([volume.path], {
                              allowButtonTarget: true,
                            })
                          : {})}
                        onDragOver={(e) => handleDragOverTarget(e, volume.path)}
                        onDragLeave={(e) => handleDragLeaveTarget(e, volume.path)}
                        onDrop={(e) => handleDropOnTarget(e, volume.path)}
                      >
                        <button
                          className="flex min-h-[29px] min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1 text-left text-[13px]"
                          aria-current={currentPath === volume.path ? "page" : undefined}
                          onClick={(e) =>
                            handleSidebarItemClick(e, volume.path, onNavigate, handleOpenInNewTab)
                          }
                          onAuxClick={(e) => {
                            if (e.button === 1) {
                              e.preventDefault();
                              handleOpenInNewTab(volume.path);
                            }
                          }}
                          title={volume.path}
                        >
                          <SmartIcon
                            icon={HardDrive}
                            className="text-muted-foreground h-[15px] w-[15px] shrink-0"
                            sysIcon={{ type: "path", value: volume.path }}
                          />
                          <span className="truncate">{volume.name}</span>
                        </button>
                        <button
                          type="button"
                          disabled={isEjecting}
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleEjectVolume(volume);
                          }}
                          title={t("sidebar.eject_volume", { name: volume.name })}
                          aria-label={t("sidebar.eject_volume", { name: volume.name })}
                          className="text-muted-foreground hover:text-foreground mr-1.5 shrink-0 rounded-full p-1 opacity-55 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-40"
                        >
                          {isEjecting ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                          ) : (
                            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                        </button>
                      </div>
                    </AppContextMenu>
                  );
                })}
            </div>
          </section>
        )}

        {/* Finder 颜色标签 */}
        <section>
          <h3 className="finder-sidebar-section-title">{t("tags.section")}</h3>
          <div className="space-y-0.5">
            {FINDER_TAG_PRESETS.map((preset) => {
              const tagPath = `${SMART_FOLDER_PREFIX}tag:${preset.id}`;
              const label = t(preset.labelKey);
              const sidebarItemActions: SidebarItemActions = {
                onOpen: () => onNavigate(tagPath),
                onOpenInNewTab: () => handleOpenInNewTab(tagPath),
                onOpenInNewWindow: () => openPathInNewWindow(tagPath),
                path: tagPath,
                name: label,
              };
              return (
                <AppContextMenu
                  key={preset.id}
                  type="sidebar-item"
                  sidebarItemActions={sidebarItemActions}
                >
                  <button
                    type="button"
                    className="finder-sidebar-row flex w-full items-center gap-2.5 px-2.5 py-1 text-[13px]"
                    aria-current={currentPath === tagPath ? "page" : undefined}
                    data-active={currentPath === tagPath}
                    onClick={(e) =>
                      handleSidebarItemClick(e, tagPath, onNavigate, handleOpenInNewTab)
                    }
                    onAuxClick={(e) => {
                      if (e.button === 1) {
                        e.preventDefault();
                        handleOpenInNewTab(tagPath);
                      }
                    }}
                    title={label}
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full shadow-xs ring-1 ring-black/15 dark:ring-white/25"
                      style={{ backgroundColor: preset.color }}
                      aria-hidden="true"
                    />
                    <span className="truncate">{label}</span>
                  </button>
                </AppContextMenu>
              );
            })}
          </div>
        </section>

        {hiddenSidebarPaths.length > 0 && (
          <section>
            <button
              className="finder-sidebar-row text-muted-foreground hover:text-foreground flex w-full items-center gap-2 px-2.5 py-1 text-left text-xs"
              onClick={() => void restoreSidebarPaths()}
            >
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              {t("sidebar.restore_items")}
            </button>
          </section>
        )}
      </div>

      {/* 底部液态玻璃功能坞：废纸篓 & 设置 */}
      <div className="finder-sidebar-footer shrink-0">
        <div className="grid grid-cols-[1.2fr_1fr] gap-1">
          <button
            className="finder-sidebar-footer-btn text-muted-foreground hover:text-foreground flex h-8 min-w-0 items-center justify-center gap-1 px-1.5 text-[11.5px] font-medium whitespace-nowrap"
            onClick={() => setTrashOpen(true)}
            aria-label={t("trash.title")}
          >
            <Trash2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{t("trash.title")}</span>
          </button>
          <button
            className="finder-sidebar-footer-btn text-muted-foreground hover:text-foreground flex h-8 min-w-0 items-center justify-center gap-1 px-1.5 text-[11.5px] font-medium whitespace-nowrap"
            onClick={(e) => {
              e.stopPropagation();
              setIsSettingsOpen(true);
            }}
          >
            <SmartIcon
              icon={Settings}
              className="h-3.5 w-3.5 shrink-0"
              sysIcon={{ type: "path" as const, value: "/System/Applications/System Settings.app" }}
            />
            <span className="truncate">{t("settings.title")}</span>
          </button>
        </div>
      </div>

      <SettingsDialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen} />

      <div
        role="separator"
        tabIndex={0}
        aria-label={t(isSidebarCollapsed ? "sidebar.show" : "sidebar.resize")}
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuenow={Math.round(isSidebarCollapsed ? 0 : sidebarWidth)}
        title={t(isSidebarCollapsed ? "sidebar.show" : "sidebar.resize")}
        className={`group absolute inset-y-3 -right-1.5 z-50 flex w-3 cursor-col-resize items-center justify-center outline-none ${
          isSidebarCollapsed ? "pointer-events-auto" : ""
        }`}
        onPointerDown={handleResizeStart}
        onKeyDown={handleResizeKeyDown}
      >
        <div
          className={`h-full w-px rounded-full transition-colors ${
            isResizing
              ? "bg-primary/70"
              : isSidebarCollapsed
                ? "bg-primary/50 group-hover:bg-primary group-focus-visible:bg-primary w-0.5"
                : "group-hover:bg-primary/50 group-focus-visible:bg-primary/70 bg-transparent"
          }`}
        />
        {isSidebarCollapsed && (
          <button
            type="button"
            className="bg-background/95 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-primary/70 absolute top-1/2 right-0 z-[60] flex h-10 w-5 translate-x-full -translate-y-1/2 items-center justify-center rounded-r-md border border-l-0 shadow-md transition-colors focus-visible:ring-2 focus-visible:outline-none"
            onClick={(event) => {
              event.stopPropagation();
              persistSidebarState(SIDEBAR_MIN_WIDTH, false);
            }}
            aria-label={t("sidebar.show")}
            title={t("sidebar.show")}
          >
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    </aside>
  );
}

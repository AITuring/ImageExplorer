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
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { AppContextMenu } from "@/components/AppContextMenu";
import { SmartIcon } from "@/components/SmartIcon";
import { filterHiddenEntries } from "@/utils/file";
import { useSetting } from "@/hooks/useSetting";
import { useTrashDialog } from "@/stores/trashDialog";

import { FileEntry, FolderItem, MountedVolume, SidebarItemActions } from "@/types";

interface SidebarProps {
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
  level = 0,
  onNavigate,
  showHiddenFiles,
}: {
  item: FolderItem;
  level?: number;
  onNavigate: (path: string) => void;
  showHiddenFiles: boolean;
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
      const entries = await invoke<FileEntry[]>("get_entries", { path: item.path });
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
        const entries = await invoke<FileEntry[]>("get_entries", { path: item.path });
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
    onOpenInTerminal: () => invoke("open_in_terminal", { path: item.path }),
    path: item.path,
    name: item.name,
  };

  return (
    <div>
      <AppContextMenu type="sidebar-item" sidebarItemActions={sidebarItemActions}>
        <button
          className="hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors"
          style={{ paddingLeft: `${level * 12 + 8}px` }}
          onClick={() => onNavigate(item.path)}
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
        children.map((child) => (
          <FolderTreeItem
            key={child.path}
            item={child}
            level={level + 1}
            onNavigate={onNavigate}
            showHiddenFiles={showHiddenFiles}
          />
        ))}
    </div>
  );
}

export function Sidebar({ onNavigate }: SidebarProps) {
  const { t } = useTranslation();
  const setTrashOpen = useTrashDialog((state) => state.setOpen);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [home, setHome] = useState<string>("");
  const [mountedVolumes, setMountedVolumes] = useState<MountedVolume[]>([]);
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

  // Finder 的“位置”会随磁盘插拔更新；轻量轮询可以覆盖 USB、网络卷和弹出操作。
  useEffect(() => {
    let cancelled = false;

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
    const interval = window.setInterval(refreshMountedVolumes, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const quickAccess = useMemo(() => getQuickAccess(t, home), [t, home]);

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
      className={`border-border/50 bg-background/40 relative z-30 flex shrink-0 flex-col border-r backdrop-blur-xl ${
        isResizing ? "" : "transition-[width] duration-150 ease-out"
      }`}
      style={{ width: `${sidebarWidth}px` }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="flex h-full min-w-0 flex-col overflow-hidden">
        {/* 快速访问 */}
        <div className="border-border/50 border-b p-3">
          <h3 className="text-muted-foreground mb-2 px-2 text-xs font-medium">
            {t("sidebar.quick_access")}
          </h3>
          <div className="space-y-0.5">
            {quickAccess.map((item) => {
              const sidebarItemActions: SidebarItemActions = {
                onOpen: () => onNavigate(item.path),
                onOpenInTerminal: () => invoke("open_in_terminal", { path: item.path }),
                path: item.path,
                name: item.name,
              };
              return (
                <AppContextMenu
                  key={item.path}
                  type="sidebar-item"
                  sidebarItemActions={sidebarItemActions}
                >
                  <button
                    className="hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors"
                    onClick={() => onNavigate(item.path)}
                  >
                    <SmartIcon
                      icon={item.icon}
                      className="text-muted-foreground h-4 w-4"
                      sysIcon={item.sysIcon}
                    />
                    <span>{item.name}</span>
                  </button>
                </AppContextMenu>
              );
            })}
          </div>
        </div>

        {/* 文件夹树 */}
        <div className="flex-1 overflow-auto p-3">
          <h3 className="text-muted-foreground mb-2 px-2 text-xs font-medium">
            {t("sidebar.folders")}
          </h3>
          <div className="w-max min-w-full space-y-0.5">
            {folderTree.map((item) => (
              <FolderTreeItem
                key={item.path}
                item={item}
                onNavigate={onNavigate}
                showHiddenFiles={showHiddenFiles}
              />
            ))}

            {mountedVolumes.length > 0 && (
              <div className="border-border/50 mt-4 border-t pt-3">
                <h3 className="text-muted-foreground mb-2 px-2 text-xs font-medium">
                  {t("sidebar.locations")}
                </h3>
                <div className="space-y-0.5">
                  {mountedVolumes.map((volume) => {
                    const sidebarItemActions: SidebarItemActions = {
                      onOpen: () => onNavigate(volume.path),
                      onOpenInTerminal: () => invoke("open_in_terminal", { path: volume.path }),
                      path: volume.path,
                      name: volume.name,
                    };

                    return (
                      <AppContextMenu
                        key={volume.path}
                        type="sidebar-item"
                        sidebarItemActions={sidebarItemActions}
                      >
                        <button
                          className="hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors"
                          onClick={() => onNavigate(volume.path)}
                          title={volume.path}
                        >
                          <SmartIcon
                            icon={HardDrive}
                            className="text-muted-foreground h-4 w-4 shrink-0"
                            sysIcon={{ type: "path", value: volume.path }}
                          />
                          <span className="truncate">{volume.name}</span>
                        </button>
                      </AppContextMenu>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 设置按钮 */}
        <div className="border-border/50 mt-auto border-t p-3">
          <button
            className="hover:bg-accent flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors"
            onClick={() => setTrashOpen(true)}
            aria-label={t("trash.title")}
          >
            <Trash2 className="text-muted-foreground h-4 w-4" aria-hidden="true" />
            <span>{t("trash.title")}</span>
          </button>
          <button
            className="hover:bg-accent mt-0.5 flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              setIsSettingsOpen(true);
            }}
          >
            <SmartIcon
              icon={Settings}
              className="text-muted-foreground h-4 w-4"
              sysIcon={{ type: "path" as const, value: "/System/Applications/System Settings.app" }}
            />
            <span>{t("settings.title")}</span>
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
        className={`group absolute inset-y-0 -right-1.5 z-50 flex w-3 cursor-col-resize items-center justify-center outline-none ${
          isSidebarCollapsed ? "pointer-events-auto" : ""
        }`}
        onPointerDown={handleResizeStart}
        onKeyDown={handleResizeKeyDown}
      >
        <div
          className={`h-full w-px transition-colors ${
            isResizing
              ? "bg-primary/70"
              : isSidebarCollapsed
                ? "bg-primary/50 group-hover:bg-primary group-focus-visible:bg-primary w-0.5"
                : "bg-border/40 group-hover:bg-primary/50 group-focus-visible:bg-primary/70"
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

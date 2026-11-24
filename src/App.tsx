import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChevronLeft, ChevronRight, ChevronUp, Loader2, X } from "lucide-react";
import { Sidebar } from "@/components/Sidebar";
import { PathBar } from "@/components/PathBar";
import { TopBar } from "@/components/TopBar";
import { FileList } from "@/components/FileList";
import { IndexingOverlay } from "@/components/IndexingOverlay";
import { TabBar } from "@/components/TabBar";
import { preloadIcon } from "@/lib/iconCache";
import { settingsManager } from "@/lib/store";
import { useSetting } from "@/hooks/useSetting";
import { useTranslation } from "react-i18next";
import { useTabs } from "@/hooks/useTabs";
import { useTabShortcuts } from "@/hooks/useTabShortcuts";
import { windowManager } from "@/lib/windowManager";
import { OperationCenter } from "@/components/OperationCenter";
import { OperationConflictDialog } from "@/components/OperationConflictDialog";
import { TrashDialog } from "@/components/TrashDialog";
import { FileInfoDialog } from "@/components/FileInfoDialog";
import { StorageAnalyzerDialog } from "@/components/StorageAnalyzerDialog";
import { BatchExportDialog } from "@/components/BatchExportDialog";
import { SdIngestDialog } from "@/components/SdIngestDialog";
import { ensureDirectoryAccess } from "@/lib/directoryAccess";
import { useLocations } from "@/stores/locations";
import { useClipboard } from "@/stores/clipboard";
import { useSplitView } from "@/stores/splitView";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

function App() {
  useEffect(() => {
    const refreshClipboard = () => void useClipboard.getState().refresh();
    window.addEventListener("focus", refreshClipboard);
    refreshClipboard();
    return () => window.removeEventListener("focus", refreshClipboard);
  }, []);
  const [isInitializing, setIsInitializing] = useState(true);
  const { i18n, t } = useTranslation();
  // 使用 useSetting 监听语言变更
  const [language] = useSetting<string | null>("language", null);

  // 响应语言变更副作用
  useEffect(() => {
    if (language) {
      console.log("[App] Language state changed:", language);
      let langToSet = language;
      if (language === "system") {
        langToSet = navigator.language;
        console.log("[App] System language detected:", langToSet);
      }
      i18n.changeLanguage(langToSet);
    }
  }, [language, i18n]);

  const { activeTab, tabs, initTabs, navigate, addTransferredTab, setHomePath, closeTab } =
    useTabs();
  const hydrateLocations = useLocations((state) => state.hydrate);
  const addRecentLocation = useLocations((state) => state.addRecentLocation);
  const locationsHydrated = useLocations((state) => state.hydrated);
  const [pendingFileSelection, setPendingFileSelection] = useState<{
    tabId: string | undefined;
    path: string;
  } | null>(null);
  const fileToSelect =
    pendingFileSelection && pendingFileSelection.tabId === activeTab?.id
      ? pendingFileSelection.path
      : null;
  const [secondaryFileToSelect, setSecondaryFileToSelect] = useState<string | null>(null);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const splitView = useSplitView();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key === "\\"
      ) {
        event.preventDefault();
        useSplitView.getState().toggleSplitView(activeTab?.path || "/");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeTab?.path]);

  useEffect(() => {
    void hydrateLocations();
  }, [hydrateLocations]);

  // Check signed update metadata after the first shell is mounted. A failed
  // check is deliberately non-fatal so offline/network-error startups remain
  // fully usable.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const update = await check();
        if (!update || cancelled) return;
        const accepted = window.confirm(`${t("updates.available", { version: update.version })}`);
        if (!accepted || cancelled) return;
        await update.downloadAndInstall();
        if (!cancelled) await relaunch();
      } catch (error) {
        console.warn("[Updater] Update check skipped:", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => {
    if (locationsHydrated && activeTab?.path) {
      void addRecentLocation(activeTab.path);
    }
  }, [activeTab?.path, addRecentLocation, locationsHydrated]);

  const handleNavigate = useCallback(
    async (path: string, selectFile?: string) => {
      try {
        const accessiblePath = await ensureDirectoryAccess(path, t("file_list.permission_title"));
        if (!accessiblePath) {
          return;
        }
        path = accessiblePath;
      } catch (error) {
        // Non-permission errors remain visible in FileList, which can show the
        // original backend message and a retry action when appropriate.
        console.error("Failed to request directory access:", error);
      }
      setPendingFileSelection(selectFile ? { tabId: activeTab?.id, path: selectFile } : null);
      navigate(path, selectFile);
    },
    [activeTab?.id, navigate, t]
  );

  const handleSecondaryNavigate = useCallback(
    async (path: string, selectFile?: string) => {
      try {
        const accessiblePath = await ensureDirectoryAccess(path, t("file_list.permission_title"));
        if (!accessiblePath) {
          return;
        }
        path = accessiblePath;
      } catch (error) {
        console.error("Failed to request directory access:", error);
      }
      setSecondaryFileToSelect(selectFile ?? null);
      splitView.navigateSecondary(path);
    },
    [splitView, t]
  );

  const handleSidebarNavigate = useCallback(
    (path: string, selectFile?: string) => {
      if (splitView.enabled && splitView.activePane === "secondary") {
        void handleSecondaryNavigate(path, selectFile);
      } else {
        void handleNavigate(path, selectFile);
      }
    },
    [handleNavigate, handleSecondaryNavigate, splitView.activePane, splitView.enabled]
  );

  const handleSplitPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const container = splitContainerRef.current;
      if (!container) return;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const handleMove = (moveEvent: PointerEvent) => {
        const rect = container.getBoundingClientRect();
        if (rect.width <= 0) return;
        splitView.setSplitRatio((moveEvent.clientX - rect.left) / rect.width);
      };
      const handleUp = () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        window.removeEventListener("pointercancel", handleUp);
      };
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
      window.addEventListener("pointercancel", handleUp);
    },
    [splitView]
  );

  // 监听跨窗口 Tab 移动完成事件（关闭源 Tab 或窗口）
  useEffect(() => {
    let unlisten: () => void;

    const setupListener = async () => {
      unlisten = await listen<{ tabId: string; fromWindowId: string }>(
        "tab-transfer-complete",
        async (event) => {
          const { tabId, fromWindowId } = event.payload;
          // 如果事件也是从我自己这里发出的（即我是源窗口），则关闭 Tab
          if (fromWindowId === windowManager.getWindowId()) {
            console.log("[App] Closing transferred tab:", tabId);

            // 如果这是最后一个 Tab，关闭整个窗口
            if (tabs.length === 1) {
              const currentWindow = getCurrentWindow();
              await currentWindow.close();
            } else {
              closeTab(tabId);
            }
          }
        }
      );
    };
    setupListener();
    return () => {
      if (unlisten) unlisten();
    };
  }, [closeTab, tabs.length]);

  // 监听跨窗口 Tab 接收事件（目标窗口接收 Tab）
  useEffect(() => {
    const setup = async () => {
      await windowManager.listenTabTransfer(async (payload) => {
        console.log(
          "[App] Received tab transfer:",
          payload.tab.title,
          "from",
          payload.fromWindowId
        );
        addTransferredTab(payload.tab);

        // 通知源窗口关闭对应 Tab
        await emit("tab-transfer-complete", {
          tabId: payload.tab.id,
          fromWindowId: payload.fromWindowId,
        });
      });
    };
    setup();

    return () => {
      windowManager.cleanup();
    };
  }, [addTransferredTab]);

  // 注册 Tab 快捷键
  useTabShortcuts();

  // 预加载关键图标（阻塞渲染，确保不闪烁）
  const preloadCriticalIcons = async (homePath: string) => {
    try {
      // 只预加载最关键的图标：文件夹 + 当前目录
      await Promise.all([preloadIcon("folder", ""), preloadIcon("path", homePath)]);
    } catch (e) {
      console.error("Failed to preload critical icons:", e);
    }
  };

  // 预加载其他常用图标（不阻塞渲染）
  const preloadOtherIcons = async (homePath: string) => {
    try {
      // 预加载其他常用目录图标
      const commonPaths = [
        `${homePath}/Desktop`,
        `${homePath}/Documents`,
        `${homePath}/Downloads`,
        `${homePath}/Pictures`,
        `${homePath}/Movies`,
        `${homePath}/Music`,
      ];

      // 预加载常用文件类型图标
      const commonExtensions = ["pdf", "txt", "png", "jpg", "mp4", "zip", "ts", "js", "md", "json"];

      // 并行加载所有图标
      await Promise.all([
        ...commonPaths.map((path) => preloadIcon("path", path)),
        ...commonExtensions.map((ext) => preloadIcon("ext", ext)),
      ]);
    } catch (e) {
      console.error("Failed to preload other icons:", e);
    }
  };

  // 防止 React StrictMode 导致的重复初始化
  const hasInitialized = useRef(false);

  useEffect(() => {
    // 防止重复初始化
    if (hasInitialized.current) {
      console.log("[App] Already initialized, skipping");
      return;
    }
    hasInitialized.current = true;

    async function init() {
      try {
        // 并行初始化：获取主目录 + 加载设置
        const [homePath, savedLang] = await Promise.all([
          invoke<string>("get_home_dir"),
          settingsManager.getLanguage(),
        ]);

        if (savedLang && savedLang !== "system") {
          i18n.changeLanguage(savedLang);
        }

        // 检查是否有 URL 参数传入的初始路径或 Tab
        const initialTab = windowManager.getInitialTab();
        const initialPath = windowManager.getInitialPath();

        console.log("[App] Window ID:", windowManager.getWindowId());
        // console.log("[App] Initial Tab:", initialTab);
        // console.log("[App] Initial Path:", initialPath);

        // 1. 先初始化 Tab 数据，确保 UI 有内容渲染
        if (initialTab) {
          // 从其他窗口传输过来的 Tab
          console.log("[App] Adding transferred tab");
          addTransferredTab(initialTab);
          // 设置正确的 homePath
          setHomePath(homePath);
        } else {
          // 正常初始化
          console.log("[App] Normal init with path:", initialPath || homePath);
          initTabs(initialPath || homePath);
        }

        // 2. 立即解除 Loading 状态，让用户看到界面
        setIsInitializing(false);
        void emit("window-ready", { windowId: windowManager.getWindowId() });

        // 3. 后台预加载图标（不阻塞 UI）
        preloadCriticalIcons(homePath).catch((e) => console.error(e));

        // 异步预加载其他图标
        preloadOtherIcons(homePath).catch((e) => {
          console.error("Failed to preload other icons:", e);
        });
      } catch (e) {
        console.error("Failed to initialize app:", e);
        initTabs("/");
        setIsInitializing(false);
        void emit("window-ready", { windowId: windowManager.getWindowId() });
      }
    }
    init();

    // 移除旧的手动监听逻辑，改由 useSetting + useEffect 处理
  }, [addTransferredTab, initTabs, setHomePath, i18n]); // 只在组件挂载时执行一次

  return (
    <div
      className="finder-window relative flex h-screen overflow-hidden"
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 索引加载遮罩 */}
      <IndexingOverlay />
      <OperationCenter />
      <OperationConflictDialog />
      <TrashDialog />
      <FileInfoDialog />
      <StorageAnalyzerDialog onNavigate={handleNavigate} />
      <BatchExportDialog onNavigate={handleNavigate} />
      <SdIngestDialog onNavigate={handleNavigate} />

      {isInitializing ? (
        <div className="flex h-full flex-1 items-center justify-center">
          <Loader2 className="text-primary h-8 w-8 animate-spin" />
        </div>
      ) : (
        <>
          <div className="finder-traffic-region" data-tauri-drag-region />
          <Sidebar
            onNavigate={handleSidebarNavigate}
            currentPath={
              splitView.enabled && splitView.activePane === "secondary"
                ? splitView.secondaryPath
                : (activeTab?.path ?? "")
            }
          />
          <div className="finder-workspace flex min-w-0 flex-1 flex-col overflow-hidden">
            <TopBar onNavigate={handleNavigate} />
            <TabBar />
            <main
              ref={splitContainerRef}
              className="finder-content flex min-h-0 flex-1 overflow-hidden"
            >
              <div
                onMouseDown={() => splitView.enabled && splitView.setActivePane("primary")}
                style={
                  splitView.enabled
                    ? { width: `${(splitView.splitRatio * 100).toFixed(2)}%` }
                    : undefined
                }
                className={`flex min-h-0 min-w-0 flex-col overflow-hidden ${
                  splitView.enabled ? "shrink-0" : "flex-1"
                } ${
                  splitView.enabled && splitView.activePane === "primary"
                    ? "ring-primary/35 ring-1 ring-inset"
                    : ""
                }`}
              >
                {activeTab?.path ? (
                  <FileList
                    currentPath={activeTab.path}
                    onNavigate={handleNavigate}
                    fileToSelect={fileToSelect}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center" />
                )}
              </div>

              {splitView.enabled && (
                <>
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    onPointerDown={handleSplitPointerDown}
                    onDoubleClick={() => splitView.setSplitRatio(0.5)}
                    className="group bg-border/50 hover:bg-primary/60 relative z-20 w-1 shrink-0 cursor-col-resize transition-colors"
                  />
                  <div
                    onMouseDown={() => splitView.setActivePane("secondary")}
                    className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${
                      splitView.activePane === "secondary"
                        ? "ring-primary/35 ring-1 ring-inset"
                        : ""
                    }`}
                  >
                    <div className="border-border/50 bg-muted/25 flex h-8 shrink-0 items-center gap-1 border-b px-2 text-xs">
                      <button
                        type="button"
                        disabled={splitView.secondaryHistoryIndex <= 0}
                        onClick={() => splitView.goBackSecondary()}
                        aria-label={t("nav.back")}
                        className="text-muted-foreground hover:bg-accent hover:text-foreground rounded p-1 disabled:opacity-35"
                      >
                        <ChevronLeft className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={
                          splitView.secondaryHistoryIndex >= splitView.secondaryHistory.length - 1
                        }
                        onClick={() => splitView.goForwardSecondary()}
                        aria-label={t("nav.forward")}
                        className="text-muted-foreground hover:bg-accent hover:text-foreground rounded p-1 disabled:opacity-35"
                      >
                        <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={!splitView.secondaryPath || splitView.secondaryPath === "/"}
                        onClick={() => {
                          const normalized = splitView.secondaryPath.replace(/\/+$/, "");
                          const slash = normalized.lastIndexOf("/");
                          const parent = slash <= 0 ? "/" : normalized.slice(0, slash);
                          void handleSecondaryNavigate(parent);
                        }}
                        aria-label={t("storage_analyzer.parent_folder")}
                        className="text-muted-foreground hover:bg-accent hover:text-foreground rounded p-1 disabled:opacity-35"
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                      </button>
                      <span
                        className="text-muted-foreground min-w-0 flex-1 truncate px-1 font-mono text-[11px]"
                        title={splitView.secondaryPath}
                      >
                        {splitView.secondaryPath}
                      </span>
                      <button
                        type="button"
                        onClick={() => splitView.closeSplitView()}
                        aria-label={t("common.split_pane_close")}
                        title={t("common.split_pane_close")}
                        className="text-muted-foreground hover:bg-accent hover:text-foreground rounded p-1"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="min-h-0 flex-1 overflow-hidden">
                      <FileList
                        currentPath={splitView.secondaryPath || activeTab?.path || "/"}
                        onNavigate={handleSecondaryNavigate}
                        fileToSelect={secondaryFileToSelect}
                      />
                    </div>
                  </div>
                </>
              )}
            </main>
            <PathBar path={activeTab?.path ?? ""} onNavigate={handleNavigate} />
          </div>
        </>
      )}
    </div>
  );
}

export default App;

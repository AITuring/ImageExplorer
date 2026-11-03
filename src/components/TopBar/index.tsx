import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Search,
  ChevronLeft,
  ChevronRight,
  Folder,
  File,
  X,
  LayoutGrid,
  List as ListIcon,
  Columns,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { AppContextMenu } from "@/components/AppContextMenu";
import { TextInputActions, SearchResult, SearchResponse, FileActions, FileEntry } from "@/types";
import { SmartIcon } from "@/components/SmartIcon";
import { useViewMode } from "@/stores/viewMode";
import { useTabs } from "@/hooks/useTabs";
import { SEARCH_DEBOUNCE_MS, FOCUS_DELAY_MS, SMART_FOLDER_PREFIX } from "@/constants/config";
import { filterHiddenEntries } from "@/utils/file";
import { useSetting } from "@/hooks/useSetting";
import { useClipboard } from "@/stores/clipboard";
import { useFileInfoDialog } from "@/stores/fileInfoDialog";
import { useLocations } from "@/stores/locations";
import { usePhotoAnalysisProgress } from "@/stores/photoAnalysisProgress";
import { isCommandEnabled, runCommand } from "@/lib/commands";
import { viewModeCommands } from "@/lib/viewModeCommands";
import { PhotoAnalysisProgressIndicator } from "@/components/PhotoAnalysisProgressIndicator";
import {
  enqueueCompressOperation,
  enqueueExtractOperation,
  enqueueFileOperation,
} from "@/lib/fileOperations";

interface TopBarProps {
  onNavigate?: (path: string, selectFile?: string) => void;
}

type SearchScope = "indexed" | "current";

function cancelScopedSearch(version: number) {
  void invoke("cancel_directory_search", {
    requestId: Date.now() * 1000 + version,
  }).catch((error) => console.error("Could not cancel scoped search:", error));
}

function toSearchFileEntry(result: SearchResult): FileEntry {
  return {
    name: result.name,
    path: result.path,
    is_dir: result.is_dir,
    size: 0,
    modified: null,
    extension: result.extension ?? null,
    readonly: false,
    is_hidden: result.is_hidden ?? result.name.startsWith("."),
  };
}

function getParentPath(path: string): string | null {
  const normalizedPath = path.replace(/\/+$/, "");
  const separatorIndex = normalizedPath.lastIndexOf("/");
  if (separatorIndex < 0) return null;
  return separatorIndex === 0 ? "/" : normalizedPath.slice(0, separatorIndex);
}

export function TopBar({ onNavigate }: TopBarProps) {
  const { t } = useTranslation();
  const { activeTab, navigate, goBack, goForward, canGoBack, canGoForward, addTab } = useTabs();
  const navigateTo = onNavigate ?? navigate;
  const currentPath = activeTab?.path || "";

  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(currentPath);

  const { viewMode } = useViewMode();
  const { scopePath: photoAnalysisScope, progress: photoAnalysisProgress } =
    usePhotoAnalysisProgress();
  const [showHiddenFiles] = useSetting<boolean>("show_hidden_files", false);
  const clipboard = useClipboard();
  const openFileInfo = useFileInfoDialog((state) => state.open);
  const favorites = useLocations((state) => state.favorites);
  const toggleFavorite = useLocations((state) => state.toggleFavorite);

  // 搜索状态
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchWarning, setSearchWarning] = useState<string | null>(null);
  const [indexReconciling, setIndexReconciling] = useState(false);
  const [indexFailed, setIndexFailed] = useState(false);
  const [searchScope, setSearchScope] = useState<SearchScope>("indexed");
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const visibleSearchResults = useMemo(
    () => filterHiddenEntries(searchResults, showHiddenFiles),
    [searchResults, showHiddenFiles]
  );

  const inputRef = useRef<HTMLInputElement>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [selectedSearchPaths, setSelectedSearchPaths] = useState<string[]>([]);
  const [editingSearchPath, setEditingSearchPath] = useState<string | null>(null);
  const [editingSearchValue, setEditingSearchValue] = useState("");
  const searchInputRef = useRef<HTMLDivElement>(null);
  const searchFieldRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchVersionRef = useRef(0); // 用于取消旧请求
  const scopedSearchPathRef = useRef(currentPath);
  const isComposingRef = useRef(false); // 标记正在使用输入法

  useEffect(() => {
    setEditValue(currentPath);
  }, [currentPath]);

  // 组件卸载时清除搜索防抖
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  // 聚焦时全选文本
  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (isEditing && inputRef.current) {
      // 延迟执行以确保在 DOM 更新和菜单关闭后生效
      timer = setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, FOCUS_DELAY_MS);
    }
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [isEditing]);

  // Indexed Home search and direct traversal of the current folder.
  const handleSearch = useCallback(
    async (query: string, version: number, scope: SearchScope) => {
      // 如果正在输入拼音，不要搜索
      if (isComposingRef.current) return;

      if (!query.trim()) {
        setSearchResults([]);
        setSearchHasMore(false);
        setSearchError(null);
        setSearchWarning(null);
        setIndexReconciling(false);
        setIndexFailed(false);
        setShowResults(false);
        setIsSearching(false);
        return;
      }

      try {
        const response =
          scope === "current"
            ? await invoke<SearchResponse>("search_directory", {
                root: currentPath,
                query,
                limit: 51,
                requestId: Date.now() * 1000 + version,
              })
            : await invoke<SearchResponse>("search_indexed", { query, limit: 51 });

        // 只接受最新版本的结果
        if (version === searchVersionRef.current) {
          setSearchResults(response.results.slice(0, 50));
          setSearchHasMore(response.results.length > 50);
          setSearchError(null);
          setSearchWarning(response.warning ?? null);
          setIndexReconciling(response.index_reconciling ?? false);
          setIndexFailed(response.index_failed ?? false);
          setIsSearching(false);
        }
      } catch (e) {
        console.error("Search failed:", e);
        if (version === searchVersionRef.current) {
          setSearchResults([]);
          setSearchHasMore(false);
          setSearchError(String(e));
          setSearchWarning(null);
          setIndexReconciling(false);
          setIndexFailed(false);
          setIsSearching(false);
        }
      }
    },
    [currentPath]
  );

  const loadMoreSearchResults = useCallback(async () => {
    if (isLoadingMore || !searchHasMore || !searchQuery.trim()) return;
    const version = searchVersionRef.current;
    const requestedLimit = searchResults.length + 51;
    setIsLoadingMore(true);
    try {
      const response =
        searchScope === "current"
          ? await invoke<SearchResponse>("search_directory", {
              root: currentPath,
              query: searchQuery,
              limit: requestedLimit,
              requestId: Date.now() * 1000 + version,
            })
          : await invoke<SearchResponse>("search_indexed", {
              query: searchQuery,
              limit: requestedLimit,
            });
      if (version === searchVersionRef.current) {
        setSearchResults(response.results.slice(0, requestedLimit - 1));
        setSearchHasMore(response.results.length === requestedLimit);
        setSearchError(null);
        setSearchWarning(response.warning ?? null);
        setIndexReconciling(response.index_reconciling ?? false);
        setIndexFailed(response.index_failed ?? false);
      }
    } catch (error) {
      if (version === searchVersionRef.current) setSearchError(String(error));
    } finally {
      setIsLoadingMore(false);
    }
  }, [currentPath, isLoadingMore, searchHasMore, searchQuery, searchResults.length, searchScope]);

  const handleSearchInputChange = (value: string) => {
    setSearchQuery(value);
    setSearchError(null);
    setSearchWarning(null);
    setIndexReconciling(false);
    setIndexFailed(false);
    setSearchHasMore(false);

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    // 递增版本号
    searchVersionRef.current += 1;
    const currentVersion = searchVersionRef.current;
    cancelScopedSearch(currentVersion);

    // 有输入内容时立即显示下拉框和 loading
    if (value.trim() && !isComposingRef.current) {
      setShowResults(true);
      setIsSearching(true);
    } else if (!value.trim()) {
      setShowResults(false);
      setIsSearching(false);
      setSearchResults([]);
    }

    // Debounce input before starting an indexed query or directory traversal.
    debounceRef.current = setTimeout(() => {
      handleSearch(value, currentVersion, searchScope);
    }, SEARCH_DEBOUNCE_MS);
  };

  const changeSearchScope = (scope: SearchScope) => {
    if (
      scope === searchScope ||
      (scope === "current" && currentPath.startsWith(SMART_FOLDER_PREFIX))
    )
      return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSearchScope(scope);
    setSearchResults([]);
    setSearchError(null);
    setSearchWarning(null);
    setIndexReconciling(false);
    setIndexFailed(false);
    setSearchHasMore(false);
    searchVersionRef.current += 1;
    cancelScopedSearch(searchVersionRef.current);
    if (searchQuery.trim()) {
      setIsSearching(true);
      setShowResults(true);
      void handleSearch(searchQuery, searchVersionRef.current, scope);
    }
  };

  useEffect(() => {
    if (scopedSearchPathRef.current === currentPath) return;
    scopedSearchPathRef.current = currentPath;
    if (searchScope !== "current" || !searchQuery.trim()) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const scope = currentPath.startsWith(SMART_FOLDER_PREFIX) ? "indexed" : "current";
    if (scope !== searchScope) setSearchScope(scope);
    searchVersionRef.current += 1;
    cancelScopedSearch(searchVersionRef.current);
    setIsSearching(true);
    setShowResults(true);
    void handleSearch(searchQuery, searchVersionRef.current, scope);
  }, [currentPath, handleSearch, searchQuery, searchScope]);

  useEffect(() => {
    if (!searchOpen || !searchQuery.trim()) return;
    let disposed = false;
    const unlisten: Array<() => void> = [];
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        searchVersionRef.current += 1;
        void handleSearch(searchQuery, searchVersionRef.current, searchScope);
      }, 250);
    };
    const register = async () => {
      const subscriptions = await Promise.allSettled([
        listen<string>("dir-change", ({ payload }) => {
          if (
            searchScope === "current" &&
            (payload === currentPath || payload.startsWith(`${currentPath.replace(/\/$/, "")}/`))
          ) {
            refresh();
          }
        }),
        listen("index-ready", () => {
          if (searchScope === "indexed") refresh();
        }),
        listen<string>("index-status", ({ payload }) => {
          if (searchScope === "indexed" && ["building", "ready", "failed"].includes(payload)) {
            refresh();
          }
        }),
        listen<{ status: string }>("file-operation-updated", ({ payload }) => {
          if (["completed", "failed", "cancelled"].includes(payload.status)) refresh();
        }),
      ]);
      for (const subscription of subscriptions) {
        if (subscription.status === "rejected") {
          console.error("Could not watch search changes:", subscription.reason);
        } else if (disposed) {
          subscription.value();
        } else {
          unlisten.push(subscription.value);
        }
      }
    };
    void register();
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      unlisten.forEach((stop) => stop());
      window.removeEventListener("focus", refresh);
    };
  }, [currentPath, handleSearch, searchOpen, searchQuery, searchScope]);

  const closeSearchResults = useCallback(() => {
    searchVersionRef.current += 1;
    cancelScopedSearch(searchVersionRef.current);
    setSearchQuery("");
    setSearchError(null);
    setSearchWarning(null);
    setSearchHasMore(false);
    setShowResults(false);
    setSearchResults([]);
    setSelectedSearchPaths([]);
    setEditingSearchPath(null);
    setSearchOpen(false);
  }, []);

  useEffect(() => {
    if (searchOpen) searchFieldRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
        searchFieldRef.current?.focus();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  const handleResultClick = (result: SearchResult) => {
    if (result.is_dir) {
      navigateTo(result.path);
    } else {
      // 导航到文件所在目录，并选中该文件
      const lastSlash = result.path.lastIndexOf("/");
      const parentPath = lastSlash > 0 ? result.path.substring(0, lastSlash) : "/";
      navigateTo(parentPath, result.path);
    }
    closeSearchResults();
  };

  const refreshSearchResults = useCallback(() => {
    if (!searchQuery.trim()) return;
    searchVersionRef.current += 1;
    setIsSearching(true);
    void handleSearch(searchQuery, searchVersionRef.current, searchScope);
  }, [handleSearch, searchQuery, searchScope]);

  const handleSearchRowClick = (result: SearchResult, event: React.MouseEvent) => {
    const isMultiSelect = event.metaKey || event.ctrlKey;
    setSelectedSearchPaths((current) => {
      if (!isMultiSelect) return [result.path];
      return current.includes(result.path)
        ? current.filter((path) => path !== result.path)
        : [...current, result.path];
    });

    if (!isMultiSelect) handleResultClick(result);
  };

  const handleSearchRowContextMenu = (result: SearchResult) => {
    setSelectedSearchPaths((current) => (current.includes(result.path) ? current : [result.path]));
  };

  const handleSearchRename = useCallback((entry: FileEntry) => {
    setEditingSearchPath(entry.path);
    setEditingSearchValue(entry.name);
  }, []);

  const submitSearchRename = useCallback(async () => {
    if (!editingSearchPath) return;
    const newName = editingSearchValue.trim();
    const oldEntry = visibleSearchResults.find((result) => result.path === editingSearchPath);
    setEditingSearchPath(null);
    if (!newName || !oldEntry || newName === oldEntry.name) return;

    try {
      await invoke("rename_with_history", { path: editingSearchPath, newName });
      refreshSearchResults();
    } catch (error) {
      console.error("Failed to rename search result:", error);
      alert(t("file_list.error_rename", { error: String(error) }));
    }
  }, [editingSearchPath, editingSearchValue, refreshSearchResults, t, visibleSearchResults]);

  const searchFileActions: FileActions = useMemo(
    () => ({
      onOpen: (entry) => {
        if (entry.is_dir) {
          navigateTo(entry.path);
        } else {
          invoke("open_file", { path: entry.path }).catch((error) =>
            console.error("Failed to open search result:", error)
          );
        }
        closeSearchResults();
      },
      onOpenInNewTab: (entry) => {
        if (entry.is_dir) {
          addTab(entry.path);
          closeSearchResults();
        }
      },
      onCopy: (entries) => void clipboard.copy(entries.map((entry) => entry.path)),
      onCut: (entries) => void clipboard.cut(entries.map((entry) => entry.path)),
      onPaste: async () => {
        const pending = await clipboard.getForPaste();
        if (!pending) return;
        try {
          if (pending.operation === "copy") {
            await enqueueFileOperation({
              kind: "copy",
              paths: pending.paths,
              destDir: currentPath,
            });
          } else {
            const operationId = await enqueueFileOperation({
              kind: "move",
              paths: pending.paths,
              destDir: currentPath,
            });
            if (operationId) await clipboard.consumeCut(pending.changeCount);
          }
        } catch (error) {
          console.error("Failed to paste from search results:", error);
          alert(t("file_list.error_paste", { error: String(error) }));
        }
      },
      onCopyPath: async (entry) => {
        try {
          await navigator.clipboard.writeText(entry.path);
        } catch (error) {
          console.error("Failed to copy search result path:", error);
        }
      },
      onDelete: async (entries) => {
        try {
          await invoke("start_delete_operation", {
            paths: entries.map((entry) => entry.path),
          });
          refreshSearchResults();
        } catch (error) {
          console.error("Failed to delete search result:", error);
          alert(t("file_list.error_delete", { error: String(error) }));
        }
      },
      onCompress: async (entries) => {
        try {
          await enqueueCompressOperation(entries.map((entry) => entry.path));
        } catch (error) {
          console.error("Failed to compress search results:", error);
          alert(t("file_list.error_operation", { error: String(error) }));
        }
      },
      onExtract: async (entry) => {
        try {
          await enqueueExtractOperation(entry.path);
        } catch (error) {
          console.error("Failed to extract search result:", error);
          alert(t("file_list.error_operation", { error: String(error) }));
        }
      },
      onGetInfo: (entry) => openFileInfo(entry),
      onToggleFavorite: (entry) => {
        if (entry.is_dir) void toggleFavorite(entry.path);
      },
      isFavorite: (entry) => favorites.includes(entry.path),
      onRename: handleSearchRename,
      onGoToLocation: (entry) => {
        const fallbackParentPath = getParentPath(entry.path);
        if (fallbackParentPath) {
          navigateTo(fallbackParentPath, entry.path);
          closeSearchResults();
        }
      },
      currentPath,
    }),
    [
      addTab,
      clipboard,
      closeSearchResults,
      currentPath,
      handleSearchRename,
      navigateTo,
      openFileInfo,
      favorites,
      refreshSearchResults,
      toggleFavorite,
      t,
    ]
  );

  const selectedSearchEntries = useMemo(
    () =>
      visibleSearchResults
        .filter((result) => selectedSearchPaths.includes(result.path))
        .map(toSearchFileEntry),
    [selectedSearchPaths, visibleSearchResults]
  );

  // 点击外部关闭搜索结果
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (
        target instanceof Element &&
        target.closest("[data-context-menu-content], [data-radix-menu-content]")
      ) {
        return;
      }
      if (searchInputRef.current && !searchInputRef.current.contains(e.target as Node)) {
        setShowResults(false);
        if (!searchQuery) setSearchOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [searchQuery]);

  const pathSegments = currentPath.split("/").filter(Boolean);

  const handleSubmit = () => {
    setIsEditing(false);
    if (editValue && editValue !== currentPath) {
      navigateTo(editValue);
    }
  };

  // 文本输入框的操作
  const textInputActions: TextInputActions = {
    onCopy: async () => {
      await navigator.clipboard.writeText(editValue);
    },
    onPaste: async () => {
      const text = await navigator.clipboard.readText();
      setEditValue(text);
      inputRef.current?.focus();
    },
    onSelectAll: () => {
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    },
  };

  // 地址栏(面包屑)的操作
  const addressBarActions: TextInputActions = {
    onCopy: async () => {
      await navigator.clipboard.writeText(currentPath);
    },
    onPaste: async () => {
      const text = await navigator.clipboard.readText();
      setEditValue(text);
      setIsEditing(true);
      // useEffect 里的 inputRef.current.select() 会在渲染切换后执行
    },
    onSelectAll: () => {
      setIsEditing(true);
      // 编辑模式切换后的 select 由 useEffect 处理，这里不需要 setTimeout
    },
  };

  // 搜索框的操作
  const searchInputActions: TextInputActions = {
    onCopy: async () => {
      await navigator.clipboard.writeText(searchQuery);
    },
    onPaste: async () => {
      const text = await navigator.clipboard.readText();
      handleSearchInputChange(text);
    },
    onSelectAll: () => {
      setTimeout(() => {
        const input = searchInputRef.current?.querySelector("input");
        input?.focus();
        input?.select();
      }, 0);
    },
  };

  return (
    <>
      <header
        className="finder-toolbar relative z-40 flex shrink-0 items-center"
        data-tauri-drag-region
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* 导航按钮 */}
        <div className="finder-control-group finder-navigation-group flex items-center">
          <button
            className={`rounded-md p-1.5 transition-colors ${
              canGoBack
                ? "text-muted-foreground hover:bg-accent hover:text-foreground"
                : "text-muted-foreground/30 cursor-not-allowed"
            }`}
            onClick={goBack}
            disabled={!canGoBack}
            aria-label={t("nav.back")}
            title={t("nav.back")}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            className={`rounded-md p-1.5 transition-colors ${
              canGoForward
                ? "text-muted-foreground hover:bg-accent hover:text-foreground"
                : "text-muted-foreground/30 cursor-not-allowed"
            }`}
            onClick={goForward}
            disabled={!canGoForward}
            aria-label={t("nav.forward")}
            title={t("nav.forward")}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        {/* 地址栏 */}
        <div className="finder-location flex min-w-0 flex-1 items-center">
          {isEditing ? (
            <AppContextMenu type="text-input" textInputActions={textInputActions} asChild>
              <input
                ref={inputRef}
                type="text"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={handleSubmit}
                onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
                className="bg-accent/50 h-8 w-full rounded-md border-none px-3 text-sm shadow-[0_0_0_2px_rgba(0,0,0,0.08)] outline-none"
                autoFocus
              />
            </AppContextMenu>
          ) : (
            <AppContextMenu type="text-input" textInputActions={addressBarActions} asChild>
              <button
                type="button"
                className="finder-location-button flex min-w-0 items-center gap-2"
                onClick={() => setIsEditing(true)}
                title={currentPath}
                aria-label={t("nav.edit_path")}
              >
                <Folder className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{pathSegments[pathSegments.length - 1] || "/"}</span>
              </button>
            </AppContextMenu>
          )}
        </div>

        {/* 视图切换 */}
        <div className="finder-control-group finder-view-modes flex shrink-0 items-center">
          <button
            className={`rounded-sm p-1 transition-colors ${
              viewMode === "icon"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => runCommand(viewModeCommands.icon)}
            disabled={!isCommandEnabled(viewModeCommands.icon)}
            aria-pressed={viewMode === "icon"}
            title={t("common.view_icon")}
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            className={`rounded-sm p-1 transition-colors ${
              viewMode === "list"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => runCommand(viewModeCommands.list)}
            disabled={!isCommandEnabled(viewModeCommands.list)}
            aria-pressed={viewMode === "list"}
            title={t("common.view_list")}
          >
            <ListIcon className="h-4 w-4" />
          </button>
          <button
            className={`rounded-sm p-1 transition-colors ${
              viewMode === "column"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => runCommand(viewModeCommands.column)}
            disabled={!isCommandEnabled(viewModeCommands.column)}
            aria-pressed={viewMode === "column"}
            title={t("common.view_column")}
          >
            <Columns className="h-4 w-4" />
          </button>
        </div>

        {/* 搜索框 */}
        <div
          className={`finder-search relative shrink-0 ${searchOpen ? "finder-search-expanded" : ""}`}
          ref={searchInputRef}
        >
          {searchOpen ? (
            <>
              <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
              <AppContextMenu type="text-input" textInputActions={searchInputActions} asChild>
                <input
                  ref={searchFieldRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => handleSearchInputChange(e.target.value)}
                  onFocus={() => searchQuery && setShowResults(true)}
                  onCompositionStart={() => (isComposingRef.current = true)}
                  onCompositionEnd={(e) => {
                    isComposingRef.current = false;
                    // 组合结束后立即触发搜索
                    handleSearchInputChange(e.currentTarget.value);
                  }}
                  placeholder={t("nav.search_placeholder")}
                  aria-label={t("nav.search_placeholder")}
                  className="finder-search-input placeholder:text-muted-foreground h-8 w-full pr-8 pl-9 outline-none"
                />
              </AppContextMenu>
            </>
          ) : (
            <button
              type="button"
              className="finder-search-trigger flex h-8 w-8 items-center justify-center"
              onClick={() => setSearchOpen(true)}
              aria-label={t("nav.search_placeholder")}
              title={t("nav.search_placeholder")}
            >
              <Search className="h-4 w-4" />
            </button>
          )}

          {/* 清空按钮 */}
          {searchQuery && (
            <button
              className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-0.5 transition-colors"
              onClick={() => {
                handleSearchInputChange("");
                searchInputRef.current?.querySelector("input")?.focus();
              }}
            >
              <X className="h-3 w-3" />
            </button>
          )}

          {/* 搜索结果下拉框 */}
          {showResults && (
            <div className="finder-popover text-popover-foreground absolute top-full right-0 z-[100] mt-2 w-[min(500px,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border shadow-xl">
              <div
                className="border-border/60 flex gap-1 border-b p-2"
                role="group"
                aria-label={t("search.scope_label")}
              >
                <button
                  type="button"
                  className={`rounded-md px-2.5 py-1 text-xs ${searchScope === "indexed" ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-accent"}`}
                  onClick={() => changeSearchScope("indexed")}
                  aria-pressed={searchScope === "indexed"}
                >
                  {t("search.scope_indexed")}
                </button>
                <button
                  type="button"
                  className={`rounded-md px-2.5 py-1 text-xs ${searchScope === "current" ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-accent"}`}
                  onClick={() => changeSearchScope("current")}
                  aria-pressed={searchScope === "current"}
                  disabled={currentPath.startsWith(SMART_FOLDER_PREFIX)}
                >
                  {t("search.scope_current")}
                </button>
              </div>
              {isSearching ? (
                <div className="text-muted-foreground flex items-center justify-center p-4 text-sm">
                  {t("search.searching")}
                </div>
              ) : searchError ? (
                <div className="text-destructive p-4 text-sm" role="alert">
                  <p>{t("search.failed")}</p>
                  <p className="mt-1 text-xs break-words opacity-80">{searchError}</p>
                </div>
              ) : visibleSearchResults.length > 0 || searchHasMore ? (
                <>
                  <div className="bg-muted/50 text-muted-foreground flex justify-between px-3 py-1.5 text-xs font-medium">
                    <span>{t("search.results_label")}</span>
                  </div>
                  <ul className="max-h-[60vh] overflow-y-auto py-1">
                    {visibleSearchResults.map((result) => {
                      const entry = toSearchFileEntry(result);
                      const isSelected = selectedSearchPaths.includes(result.path);
                      const isEditing = editingSearchPath === result.path;

                      return (
                        <li key={result.path}>
                          <AppContextMenu
                            type={result.is_dir ? "folder" : "file"}
                            entry={entry}
                            selectedEntries={selectedSearchEntries}
                            fileActions={searchFileActions}
                            asChild
                          >
                            <div
                              className={`flex min-w-0 items-center gap-2 px-3 py-2 text-sm ${
                                isSelected ? "bg-accent" : "hover:bg-accent"
                              }`}
                              onContextMenu={() => handleSearchRowContextMenu(result)}
                            >
                              {isEditing ? (
                                <>
                                  <SmartIcon
                                    icon={result.is_dir ? Folder : File}
                                    className="text-muted-foreground h-4 w-4 shrink-0"
                                    sysIcon={
                                      result.is_dir
                                        ? { type: "folder" }
                                        : { type: "ext", value: result.extension || "" }
                                    }
                                  />
                                  <input
                                    value={editingSearchValue}
                                    onChange={(event) => setEditingSearchValue(event.target.value)}
                                    onBlur={() => void submitSearchRename()}
                                    onKeyDown={(event) => {
                                      event.stopPropagation();
                                      if (event.key === "Enter") {
                                        event.preventDefault();
                                        void submitSearchRename();
                                      } else if (event.key === "Escape") {
                                        event.preventDefault();
                                        setEditingSearchPath(null);
                                      }
                                    }}
                                    className="bg-background min-w-0 flex-1 rounded border px-1.5 py-0.5 outline-none focus-visible:ring-1"
                                    autoFocus
                                    aria-label={t("context_menu.rename")}
                                  />
                                </>
                              ) : (
                                <button
                                  type="button"
                                  className="focus-visible:ring-primary/60 flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-2"
                                  onClick={(event) => handleSearchRowClick(result, event)}
                                  title={result.path}
                                >
                                  <SmartIcon
                                    icon={result.is_dir ? Folder : File}
                                    className={
                                      result.is_dir
                                        ? "h-4 w-4 shrink-0 text-blue-500"
                                        : "text-muted-foreground h-4 w-4 shrink-0"
                                    }
                                    sysIcon={
                                      result.is_dir
                                        ? { type: "folder" }
                                        : { type: "ext", value: result.extension || "" }
                                    }
                                  />
                                  <span className="min-w-0 flex-1 truncate">{result.name}</span>
                                  <span className="text-muted-foreground max-w-[42%] min-w-0 shrink truncate text-xs opacity-60">
                                    {result.path}
                                  </span>
                                </button>
                              )}
                            </div>
                          </AppContextMenu>
                        </li>
                      );
                    })}
                  </ul>
                  {searchHasMore && (
                    <button
                      type="button"
                      className="text-primary hover:bg-accent w-full border-t px-3 py-2 text-center text-xs"
                      onClick={() => void loadMoreSearchResults()}
                      disabled={isLoadingMore}
                    >
                      {isLoadingMore ? t("search.searching") : t("search.load_more")}
                    </button>
                  )}
                </>
              ) : (
                <div className="text-muted-foreground p-4 text-center text-sm">
                  {t("search.no_results")}
                </div>
              )}
              {searchWarning && (
                <p
                  className="border-border/60 border-t px-3 py-2 text-xs text-amber-500"
                  role="status"
                >
                  {t("search.partial_results")}: {searchWarning}
                </p>
              )}
              {indexReconciling && (
                <p
                  className="border-border/60 text-muted-foreground border-t px-3 py-2 text-xs"
                  role="status"
                >
                  {t("search.index_reconciling")}
                </p>
              )}
              {indexFailed && (
                <p
                  className="border-border/60 border-t px-3 py-2 text-xs text-amber-500"
                  role="status"
                >
                  {t("search.index_failed")}
                </p>
              )}
            </div>
          )}
        </div>
      </header>
      {photoAnalysisScope === currentPath && (
        <PhotoAnalysisProgressIndicator progress={photoAnalysisProgress} />
      )}
    </>
  );
}

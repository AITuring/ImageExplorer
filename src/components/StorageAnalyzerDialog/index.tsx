import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronUp, Copy, File, Folder, HardDrive, Loader2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useStorageAnalyzerDialog } from "@/stores/storageAnalyzerDialog";
import { formatDate, formatFileSize } from "@/utils/format";

interface StorageChildEntry {
  name: string;
  path: string;
  isDir: boolean;
  bytes: number;
  fileCount: number;
  percent: number;
}

interface LargeFileEntry {
  name: string;
  path: string;
  bytes: number;
}

interface DirectoryStorageReport {
  path: string;
  totalBytes: number;
  totalFiles: number;
  totalDirs: number;
  children: StorageChildEntry[];
  largestFiles: LargeFileEntry[];
}

interface DuplicateFileItem {
  name: string;
  path: string;
  modified: number | null;
}

interface DuplicateGroup {
  hash: string;
  fileSize: number;
  wastedBytes: number;
  files: DuplicateFileItem[];
}

interface DuplicateFilesReport {
  path: string;
  scannedFiles: number;
  groupCount: number;
  wastedBytes: number;
  groups: DuplicateGroup[];
}

function parentPathOf(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  const slash = normalized.lastIndexOf("/");
  return slash <= 0 ? "/" : normalized.slice(0, slash);
}

export function StorageAnalyzerDialog({
  onNavigate,
}: {
  onNavigate: (path: string, selectFile?: string) => void;
}) {
  const { t } = useTranslation();
  const targetPath = useStorageAnalyzerDialog((state) => state.targetPath);
  const initialTab = useStorageAnalyzerDialog((state) => state.initialTab);
  const close = useStorageAnalyzerDialog((state) => state.close);

  const [activeTab, setActiveTab] = useState<"space" | "duplicates">("space");
  const [inspectPath, setInspectPath] = useState<string | null>(null);
  const [storageReport, setStorageReport] = useState<DirectoryStorageReport | null>(null);
  const [dupReport, setDupReport] = useState<DuplicateFilesReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const requestIdRef = useRef(0);

  const effectivePath = inspectPath ?? targetPath;

  const runAnalysis = useCallback(async (path: string, tab: "space" | "duplicates") => {
    const reqId = Date.now() * 1000 + ((requestIdRef.current += 1) % 1000);
    setLoading(true);
    setError(null);
    try {
      if (tab === "space") {
        const report = await invoke<DirectoryStorageReport>("analyze_directory_storage", {
          path,
          requestId: reqId,
        });
        setStorageReport(report);
      } else {
        const report = await invoke<DuplicateFilesReport>("find_duplicate_files", {
          path,
          requestId: reqId,
        });
        setDupReport(report);
      }
    } catch (err) {
      const message = String(err);
      if (!message.toLowerCase().includes("cancelled")) {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!targetPath) return;
    let cancelled = false;
    const pathToScan = inspectPath ?? targetPath;
    const reqId = Date.now() * 1000 + ((requestIdRef.current += 1) % 1000);

    const start = async () => {
      setLoading(true);
      setError(null);
      try {
        if (activeTab === "space") {
          const report = await invoke<DirectoryStorageReport>("analyze_directory_storage", {
            path: pathToScan,
            requestId: reqId,
          });
          if (!cancelled) setStorageReport(report);
        } else {
          const report = await invoke<DuplicateFilesReport>("find_duplicate_files", {
            path: pathToScan,
            requestId: reqId,
          });
          if (!cancelled) setDupReport(report);
        }
      } catch (err) {
        if (!cancelled) {
          const message = String(err);
          if (!message.toLowerCase().includes("cancelled")) {
            setError(message);
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void start();
    return () => {
      cancelled = true;
      void invoke("cancel_storage_analysis", { requestId: reqId + 1 }).catch(() => undefined);
    };
  }, [activeTab, inspectPath, targetPath]);

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setInspectPath(null);
      setStorageReport(null);
      setDupReport(null);
      setActiveTab(initialTab);
      close();
    }
  };

  const handleTrashPaths = async (paths: string[]) => {
    if (paths.length === 0 || deleting || !effectivePath) return;
    setDeleting(true);
    try {
      await invoke("start_delete_operation", { paths });
      // Wait briefly for trash operation before re-scanning
      window.setTimeout(() => {
        if (effectivePath) void runAnalysis(effectivePath, activeTab);
      }, 400);
    } catch (err) {
      alert(t("file_list.error_delete", { error: String(err) }));
    } finally {
      setDeleting(false);
    }
  };

  const handleTrashAllDuplicates = () => {
    if (!dupReport) return;
    const pathsToTrash: string[] = [];
    for (const group of dupReport.groups) {
      for (let i = 1; i < group.files.length; i++) {
        pathsToTrash.push(group.files[i].path);
      }
    }
    if (pathsToTrash.length === 0) return;
    const confirmed = window.confirm(
      t("storage_analyzer.trash_all_confirm", {
        count: pathsToTrash.length,
        size: formatFileSize(dupReport.wastedBytes),
      })
    );
    if (confirmed) {
      void handleTrashPaths(pathsToTrash);
    }
  };

  return (
    <Dialog open={Boolean(targetPath)} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[84vh] max-w-3xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HardDrive className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span>{t("storage_analyzer.title")}</span>
          </DialogTitle>
          <DialogDescription className="truncate font-mono text-xs" title={effectivePath ?? ""}>
            {effectivePath}
          </DialogDescription>
        </DialogHeader>

        {/* Tab switcher + Go Up */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setActiveTab("space")}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                activeTab === "space"
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-accent"
              }`}
            >
              <HardDrive className="h-3.5 w-3.5" aria-hidden="true" />
              {t("storage_analyzer.tab_space")}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("duplicates")}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                activeTab === "duplicates"
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-accent"
              }`}
            >
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              {t("storage_analyzer.tab_duplicates")}
            </button>
          </div>

          <div className="flex items-center gap-2">
            {effectivePath && effectivePath !== "/" && (
              <button
                type="button"
                onClick={() => setInspectPath(parentPathOf(effectivePath))}
                className="text-muted-foreground hover:bg-accent hover:text-foreground inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors"
              >
                <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                {t("storage_analyzer.parent_folder")}
              </button>
            )}
            {effectivePath && (
              <button
                type="button"
                onClick={() => {
                  onNavigate(effectivePath);
                  handleOpenChange(false);
                }}
                className="text-primary text-xs hover:underline"
              >
                {t("storage_analyzer.open_here")}
              </button>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto pr-1 text-xs">
          {loading ? (
            <div className="text-muted-foreground flex h-48 flex-col items-center justify-center gap-2">
              <Loader2 className="h-6 w-6 animate-spin" />
              <span>{t("storage_analyzer.scanning")}</span>
            </div>
          ) : error ? (
            <div className="text-destructive flex h-40 items-center justify-center">{error}</div>
          ) : activeTab === "space" && storageReport ? (
            <div className="space-y-4 py-2">
              <div className="bg-muted/35 flex flex-wrap items-center gap-4 rounded-lg px-3 py-2 text-xs tabular-nums">
                <span className="font-semibold">{formatFileSize(storageReport.totalBytes)}</span>
                <span className="text-muted-foreground">
                  {t("storage_analyzer.summary_counts", {
                    files: storageReport.totalFiles,
                    dirs: storageReport.totalDirs,
                  })}
                </span>
              </div>

              <div className="space-y-1.5">
                {storageReport.children.slice(0, 40).map((child) => (
                  <div
                    key={child.path}
                    className="hover:bg-accent/50 group flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors"
                  >
                    {child.isDir ? (
                      <Folder className="h-4 w-4 shrink-0 text-blue-500" aria-hidden="true" />
                    ) : (
                      <File className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden="true" />
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        if (child.isDir) {
                          setInspectPath(child.path);
                        } else {
                          onNavigate(parentPathOf(child.path), child.path);
                          handleOpenChange(false);
                        }
                      }}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">{child.name}</span>
                        <span className="text-muted-foreground shrink-0 tabular-nums">
                          {formatFileSize(child.bytes)} ({child.percent.toFixed(1)}%)
                        </span>
                      </div>
                      <div className="bg-muted mt-1 h-1.5 w-full overflow-hidden rounded-full">
                        <div
                          className={`h-full rounded-full ${
                            child.isDir ? "bg-blue-500/80" : "bg-emerald-500/80"
                          }`}
                          style={{ width: `${Math.max(1, Math.min(100, child.percent))}%` }}
                        />
                      </div>
                    </button>
                  </div>
                ))}
              </div>

              {storageReport.largestFiles.length > 0 && (
                <div className="border-t pt-3">
                  <h4 className="text-muted-foreground mb-2 font-medium">
                    {t("storage_analyzer.largest_files")}
                  </h4>
                  <div className="space-y-1">
                    {storageReport.largestFiles.slice(0, 15).map((file) => (
                      <button
                        key={file.path}
                        type="button"
                        onClick={() => {
                          onNavigate(parentPathOf(file.path), file.path);
                          handleOpenChange(false);
                        }}
                        className="hover:bg-accent/60 flex w-full items-center justify-between gap-3 rounded px-2 py-1 text-left transition-colors"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{file.name}</div>
                          <div className="text-muted-foreground truncate font-mono text-[10px]">
                            {file.path}
                          </div>
                        </div>
                        <span className="shrink-0 font-mono tabular-nums">
                          {formatFileSize(file.bytes)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : activeTab === "duplicates" && dupReport ? (
            <div className="space-y-3 py-2">
              <div className="bg-muted/35 flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2">
                <div className="flex flex-wrap items-center gap-3 tabular-nums">
                  <span className="font-semibold">
                    {t("storage_analyzer.dup_summary", {
                      groups: dupReport.groupCount,
                      wasted: formatFileSize(dupReport.wastedBytes),
                    })}
                  </span>
                  <span className="text-muted-foreground">
                    ({t("storage_analyzer.scanned_files", { count: dupReport.scannedFiles })})
                  </span>
                </div>
                {dupReport.groups.length > 0 && (
                  <button
                    type="button"
                    disabled={deleting}
                    onClick={handleTrashAllDuplicates}
                    className="bg-destructive/15 text-destructive hover:bg-destructive/25 inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    {t("storage_analyzer.trash_all_duplicates")}
                  </button>
                )}
              </div>

              {dupReport.groups.length === 0 ? (
                <div className="text-muted-foreground flex h-36 items-center justify-center">
                  {t("storage_analyzer.no_duplicates")}
                </div>
              ) : (
                <div className="space-y-2.5">
                  {dupReport.groups.slice(0, 60).map((group) => (
                    <div key={group.hash} className="rounded-lg border p-2.5">
                      <div className="mb-1.5 flex items-center justify-between text-[11px] tabular-nums">
                        <span className="font-medium">
                          {group.files.length} × {formatFileSize(group.fileSize)}
                        </span>
                        <span className="text-amber-600 dark:text-amber-400">
                          {t("storage_analyzer.reclaimable", {
                            size: formatFileSize(group.wastedBytes),
                          })}
                        </span>
                      </div>
                      <div className="space-y-1">
                        {group.files.map((file, idx) => (
                          <div
                            key={file.path}
                            className="hover:bg-accent/40 flex items-center justify-between gap-2 rounded px-1.5 py-1"
                          >
                            <button
                              type="button"
                              onClick={() => {
                                onNavigate(parentPathOf(file.path), file.path);
                                handleOpenChange(false);
                              }}
                              className="min-w-0 flex-1 text-left"
                            >
                              <div className="flex items-center gap-1.5">
                                {idx === 0 && (
                                  <span className="rounded bg-emerald-500/15 px-1 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                                    {t("storage_analyzer.keep_badge")}
                                  </span>
                                )}
                                <span className="truncate font-mono text-[11px]">{file.path}</span>
                              </div>
                              {file.modified && (
                                <div className="text-muted-foreground text-[10px]">
                                  {formatDate(file.modified)}
                                </div>
                              )}
                            </button>
                            <button
                              type="button"
                              disabled={deleting}
                              onClick={() => void handleTrashPaths([file.path])}
                              title={t("context_menu.move_to_trash")}
                              aria-label={t("context_menu.move_to_trash")}
                              className="text-muted-foreground hover:bg-destructive/15 hover:text-destructive shrink-0 rounded p-1 transition-colors disabled:opacity-40"
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

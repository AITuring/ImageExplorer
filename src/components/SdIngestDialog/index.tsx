import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { Camera, CheckCircle2, FolderOpen, HardDrive, Loader2, RefreshCw, X } from "lucide-react";
import { useSdIngestDialog } from "@/stores/sdIngestDialog";
import { formatFileSize } from "@/utils/format";

interface MountedVolume {
  name: string;
  path: string;
  is_removable: boolean;
}

interface SdIngestFolderSummary {
  folder: string;
  count: number;
  totalBytes: number;
}

interface SdIngestPlan {
  sourceDir: string;
  destDir: string;
  totalFiles: number;
  totalBytes: number;
  duplicateCount: number;
  photoCount: number;
  rawCount: number;
  videoCount: number;
  folders: SdIngestFolderSummary[];
}

interface SdIngestResult {
  copied: number;
  skipped: number;
  failed: string[];
  destDir: string;
  firstFolder: string | null;
}

const LAST_INGEST_DEST_KEY = "ie.sd_ingest.last_dest_dir";

interface SdIngestDialogProps {
  onNavigate?: (path: string) => void;
}

export function SdIngestDialog({ onNavigate }: SdIngestDialogProps) {
  const { t } = useTranslation();
  const { isOpen, initialSourceDir, close } = useSdIngestDialog();
  const [volumes, setVolumes] = useState<MountedVolume[]>([]);
  const [sourceDir, setSourceDir] = useState<string>("");
  const [destDir, setDestDir] = useState<string>(() => {
    try {
      return localStorage.getItem(LAST_INGEST_DEST_KEY) || "";
    } catch {
      return "";
    }
  });
  const [renamePrefixDate, setRenamePrefixDate] = useState<boolean>(false);
  const [skipDuplicates, setSkipDuplicates] = useState<boolean>(true);
  const [planning, setPlanning] = useState<boolean>(false);
  const [running, setRunning] = useState<boolean>(false);
  const [plan, setPlan] = useState<SdIngestPlan | null>(null);
  const [result, setResult] = useState<SdIngestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setResult(null);
    setError(null);
    if (initialSourceDir) {
      setSourceDir(initialSourceDir);
    }
    void invoke<MountedVolume[]>("get_mounted_volumes")
      .then((list) => {
        setVolumes(list);
        if (!initialSourceDir && !sourceDir && list.length > 0) {
          const removable = list.find((v) => v.is_removable) ?? list[0];
          setSourceDir(removable.path);
        }
      })
      .catch(() => setVolumes([]));

    if (!destDir) {
      void invoke<string>("get_home_dir")
        .then((home) => setDestDir(`${home.replace(/\/+$/, "")}/Pictures/Imported`))
        .catch(() => undefined);
    }
  }, [destDir, initialSourceDir, isOpen, sourceDir]);

  const refreshPlan = useCallback(async () => {
    if (!sourceDir.trim() || !destDir.trim()) {
      setPlan(null);
      return;
    }
    setPlanning(true);
    setError(null);
    try {
      const next = await invoke<SdIngestPlan>("plan_sd_ingest", {
        sourceDir: sourceDir.trim(),
        destDir: destDir.trim(),
        renamePrefixDate,
      });
      setPlan(next);
    } catch (err) {
      setPlan(null);
      setError(String(err));
    } finally {
      setPlanning(false);
    }
  }, [destDir, renamePrefixDate, sourceDir]);

  useEffect(() => {
    if (!isOpen) return;
    const timer = window.setTimeout(() => {
      void refreshPlan();
    }, 180);
    return () => window.clearTimeout(timer);
  }, [isOpen, refreshPlan]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !running) {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, isOpen, running]);

  if (!isOpen) return null;

  const handleChooseSource = async () => {
    const picked = await openFileDialog({
      directory: true,
      multiple: false,
      defaultPath: sourceDir || "/Volumes",
    });
    if (typeof picked === "string" && picked) setSourceDir(picked);
  };

  const handleChooseDest = async () => {
    const picked = await openFileDialog({
      directory: true,
      multiple: false,
      defaultPath: destDir || undefined,
    });
    if (typeof picked === "string" && picked) {
      setDestDir(picked);
      try {
        localStorage.setItem(LAST_INGEST_DEST_KEY, picked);
      } catch {
        // ignore storage quota errors
      }
    }
  };

  const handleRun = async () => {
    if (!sourceDir.trim() || !destDir.trim()) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      localStorage.setItem(LAST_INGEST_DEST_KEY, destDir.trim());
    } catch {
      // ignore
    }
    try {
      const res = await invoke<SdIngestResult>("run_sd_ingest", {
        sourceDir: sourceDir.trim(),
        destDir: destDir.trim(),
        renamePrefixDate,
        skipDuplicates,
      });
      setResult(res);
      void refreshPlan();
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-label={t("photo_workflow.ingest.title")}
      onClick={() => {
        if (!running) close();
      }}
    >
      <div
        className="bg-background border-border/80 flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-border/60 flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <Camera className="text-primary h-4 w-4" aria-hidden="true" />
            <h2 className="text-sm font-semibold">{t("photo_workflow.ingest.title")}</h2>
          </div>
          <button
            type="button"
            disabled={running}
            onClick={close}
            aria-label={t("common.cancel")}
            className="text-muted-foreground hover:text-foreground rounded-md p-1 disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-xs">
          {/* Quick-select mounted volumes */}
          {volumes.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-muted-foreground font-medium">
                {t("photo_workflow.ingest.detected_volumes")}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {volumes.map((vol) => (
                  <button
                    key={vol.path}
                    type="button"
                    disabled={running}
                    onClick={() => setSourceDir(vol.path)}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition-colors ${
                      sourceDir === vol.path
                        ? "border-primary bg-primary/15 text-primary font-medium"
                        : "border-border/70 text-muted-foreground hover:bg-accent"
                    }`}
                  >
                    <HardDrive className="h-3 w-3" aria-hidden="true" />
                    <span>{vol.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Source dir */}
          <div className="space-y-1.5">
            <div className="text-muted-foreground font-medium">
              {t("photo_workflow.ingest.source")}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                disabled={running}
                value={sourceDir}
                onChange={(e) => setSourceDir(e.target.value)}
                placeholder="/Volumes/Untitled/DCIM"
                className="bg-background border-border/70 min-w-0 flex-1 rounded-md border px-2.5 py-1.5 font-mono text-[11px] outline-none focus:ring-1"
              />
              <button
                type="button"
                disabled={running}
                onClick={() => void handleChooseSource()}
                className="border-border/70 hover:bg-accent inline-flex shrink-0 items-center gap-1 rounded-md border px-2.5 py-1.5 font-medium"
              >
                <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
                {t("photo_workflow.choose_folder")}
              </button>
            </div>
          </div>

          {/* Dest dir */}
          <div className="space-y-1.5">
            <div className="text-muted-foreground font-medium">
              {t("photo_workflow.ingest.dest")}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                disabled={running}
                value={destDir}
                onChange={(e) => setDestDir(e.target.value)}
                placeholder="/Users/.../Pictures/Imported"
                className="bg-background border-border/70 min-w-0 flex-1 rounded-md border px-2.5 py-1.5 font-mono text-[11px] outline-none focus:ring-1"
              />
              <button
                type="button"
                disabled={running}
                onClick={() => void handleChooseDest()}
                className="border-border/70 hover:bg-accent inline-flex shrink-0 items-center gap-1 rounded-md border px-2.5 py-1.5 font-medium"
              >
                <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
                {t("photo_workflow.choose_folder")}
              </button>
            </div>
          </div>

          {/* Options */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="border-border/60 bg-muted/20 flex cursor-pointer items-center justify-between rounded-lg border px-3 py-2">
              <span className="font-medium">{t("photo_workflow.ingest.skip_duplicates")}</span>
              <input
                type="checkbox"
                disabled={running}
                checked={skipDuplicates}
                onChange={(e) => setSkipDuplicates(e.target.checked)}
                className="accent-primary h-4 w-4"
              />
            </label>
            <label className="border-border/60 bg-muted/20 flex cursor-pointer items-center justify-between rounded-lg border px-3 py-2">
              <span className="font-medium">{t("photo_workflow.ingest.prefix_date")}</span>
              <input
                type="checkbox"
                disabled={running}
                checked={renamePrefixDate}
                onChange={(e) => setRenamePrefixDate(e.target.checked)}
                className="accent-primary h-4 w-4"
              />
            </label>
          </div>

          {/* Live Plan Preview */}
          <div className="border-border/60 bg-muted/20 space-y-2 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <span className="font-medium">{t("photo_workflow.ingest.plan_preview")}</span>
              <button
                type="button"
                disabled={planning || running}
                onClick={() => void refreshPlan()}
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[11px]"
              >
                <RefreshCw className={`h-3 w-3 ${planning ? "animate-spin" : ""}`} />
                {t("trash.refresh")}
              </button>
            </div>

            {planning ? (
              <div className="text-muted-foreground flex items-center gap-2 py-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>{t("photo_workflow.ingest.scanning")}</span>
              </div>
            ) : plan ? (
              plan.totalFiles === 0 ? (
                <div className="text-muted-foreground py-2">{t("photo_workflow.ingest.empty")}</div>
              ) : (
                <>
                  <div className="flex flex-wrap gap-3 text-[11px]">
                    <span>
                      {t("photo_workflow.ingest.summary_total", {
                        count: plan.totalFiles,
                        size: formatFileSize(plan.totalBytes),
                      })}
                    </span>
                    <span>RAW: {plan.rawCount}</span>
                    <span>JPG/IMG: {plan.photoCount}</span>
                    {plan.videoCount > 0 && <span>Video: {plan.videoCount}</span>}
                    {plan.duplicateCount > 0 && (
                      <span className="text-amber-600 dark:text-amber-400">
                        {t("photo_workflow.ingest.duplicates_found", {
                          count: plan.duplicateCount,
                        })}
                      </span>
                    )}
                  </div>
                  <div className="max-h-32 space-y-1 overflow-y-auto pt-1">
                    {plan.folders.map((folder) => (
                      <div
                        key={folder.folder}
                        className="bg-background/70 flex items-center justify-between rounded px-2 py-1 font-mono text-[11px]"
                      >
                        <span className="truncate">{folder.folder}/</span>
                        <span className="text-muted-foreground shrink-0 tabular-nums">
                          {folder.count} · {formatFileSize(folder.totalBytes)}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )
            ) : (
              <div className="text-muted-foreground py-1">{t("photo_workflow.ingest.hint")}</div>
            )}
          </div>

          {error && (
            <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2">
              {error}
            </div>
          )}

          {result && (
            <div className="space-y-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
              <div className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>
                  {t("photo_workflow.ingest.done", {
                    copied: result.copied,
                    skipped: result.skipped,
                  })}
                </span>
              </div>
              {result.failed.length > 0 && (
                <ul className="text-destructive max-h-20 list-disc overflow-y-auto pl-4 text-[11px]">
                  {result.failed.slice(0, 5).map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="border-border/60 flex items-center justify-end gap-2 border-t px-4 py-3 text-xs">
          {result && onNavigate && (
            <button
              type="button"
              onClick={() => {
                onNavigate(result.firstFolder || result.destDir);
                close();
              }}
              className="border-border/70 hover:bg-accent inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 font-medium"
            >
              <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
              {t("photo_workflow.open_dest")}
            </button>
          )}
          <button
            type="button"
            disabled={running}
            onClick={close}
            className="text-muted-foreground hover:bg-accent rounded-md px-3 py-1.5"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={running || planning || !plan || plan.totalFiles === 0}
            onClick={() => void handleRun()}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 font-medium disabled:opacity-50"
          >
            {running && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {running ? t("photo_workflow.ingest.running") : t("photo_workflow.ingest.start")}
          </button>
        </div>
      </div>
    </div>
  );
}

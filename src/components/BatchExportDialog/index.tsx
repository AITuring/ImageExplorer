import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { CheckCircle2, FolderOpen, ImageDown, Loader2, ShieldCheck, X } from "lucide-react";
import { useBatchExportDialog } from "@/stores/batchExportDialog";

interface BatchExportResult {
  exported: number;
  skipped: number;
  failed: string[];
  destDir: string;
}

type ExportFormat = "jpeg" | "heic" | "png";

const EDGE_PRESETS: Array<{ value: number; labelKey: string }> = [
  { value: 0, labelKey: "photo_workflow.export.edge_original" },
  { value: 4096, labelKey: "photo_workflow.export.edge_4096" },
  { value: 2560, labelKey: "photo_workflow.export.edge_2560" },
  { value: 1920, labelKey: "photo_workflow.export.edge_1920" },
  { value: 1280, labelKey: "photo_workflow.export.edge_1280" },
];

interface BatchExportDialogProps {
  onNavigate?: (path: string) => void;
}

export function BatchExportDialog({ onNavigate }: BatchExportDialogProps) {
  const { t } = useTranslation();
  const { isOpen, entries, defaultDestDir, close } = useBatchExportDialog();
  const [format, setFormat] = useState<ExportFormat>("jpeg");
  const [maxEdge, setMaxEdge] = useState<number>(2560);
  const [quality, setQuality] = useState<number>(90);
  const [stripGps, setStripGps] = useState<boolean>(true);
  const [destDir, setDestDir] = useState<string>("");
  const [running, setRunning] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BatchExportResult | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setResult(null);
    if (defaultDestDir) {
      setDestDir(`${defaultDestDir.replace(/\/+$/, "")}/Export`);
    }
  }, [defaultDestDir, isOpen]);

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

  const handleChooseDest = async () => {
    const picked = await openFileDialog({
      directory: true,
      multiple: false,
      defaultPath: destDir || defaultDestDir || undefined,
    });
    if (typeof picked === "string" && picked) {
      setDestDir(picked);
    }
  };

  const handleExport = async () => {
    if (!destDir.trim() || entries.length === 0) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await invoke<BatchExportResult>("batch_export_photos", {
        request: {
          paths: entries.map((e) => e.path),
          destDir: destDir.trim(),
          format,
          maxEdge,
          quality: quality / 100,
          stripGps,
          overwrite: false,
        },
      });
      setResult(res);
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
      aria-label={t("photo_workflow.export.title")}
      onClick={() => {
        if (!running) close();
      }}
    >
      <div
        className="bg-background border-border/80 flex w-full max-w-lg flex-col overflow-hidden rounded-xl border shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-border/60 flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <ImageDown className="text-primary h-4 w-4" aria-hidden="true" />
            <h2 className="text-sm font-semibold">{t("photo_workflow.export.title")}</h2>
            <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[11px] tabular-nums">
              {t("photo_workflow.export.count", { count: entries.length })}
            </span>
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

        <div className="space-y-4 p-4 text-xs">
          {/* Format */}
          <div className="space-y-1.5">
            <div className="text-muted-foreground font-medium">
              {t("photo_workflow.export.format")}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {(["jpeg", "heic", "png"] as const).map((fmt) => (
                <button
                  key={fmt}
                  type="button"
                  disabled={running}
                  onClick={() => setFormat(fmt)}
                  className={`rounded-md border px-3 py-1.5 font-medium uppercase transition-colors ${
                    format === fmt
                      ? "border-primary bg-primary/15 text-primary"
                      : "border-border/70 text-muted-foreground hover:bg-accent"
                  }`}
                >
                  {fmt}
                </button>
              ))}
            </div>
          </div>

          {/* Max long edge */}
          <div className="space-y-1.5">
            <div className="text-muted-foreground font-medium">
              {t("photo_workflow.export.max_edge")}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {EDGE_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  disabled={running}
                  onClick={() => setMaxEdge(preset.value)}
                  className={`rounded-full border px-2.5 py-1 transition-colors ${
                    maxEdge === preset.value
                      ? "border-primary bg-primary/15 text-primary font-medium"
                      : "border-border/70 text-muted-foreground hover:bg-accent"
                  }`}
                >
                  {t(preset.labelKey)}
                </button>
              ))}
            </div>
          </div>

          {/* Quality */}
          {format !== "png" && (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground font-medium">
                  {t("photo_workflow.export.quality")}
                </span>
                <span className="font-mono font-medium tabular-nums">{quality}%</span>
              </div>
              <input
                type="range"
                min={60}
                max={100}
                step={5}
                disabled={running}
                value={quality}
                onChange={(e) => setQuality(Number(e.target.value))}
                className="accent-primary w-full"
              />
            </div>
          )}

          {/* Strip GPS */}
          <label className="border-border/60 bg-muted/25 flex cursor-pointer items-center justify-between rounded-lg border px-3 py-2">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-500" aria-hidden="true" />
              <div>
                <div className="font-medium">{t("photo_workflow.export.strip_gps")}</div>
                <div className="text-muted-foreground text-[11px]">
                  {t("photo_workflow.export.strip_gps_hint")}
                </div>
              </div>
            </div>
            <input
              type="checkbox"
              disabled={running}
              checked={stripGps}
              onChange={(e) => setStripGps(e.target.checked)}
              className="accent-primary h-4 w-4"
            />
          </label>

          {/* Destination folder */}
          <div className="space-y-1.5">
            <div className="text-muted-foreground font-medium">
              {t("photo_workflow.export.dest")}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                disabled={running}
                value={destDir}
                onChange={(e) => setDestDir(e.target.value)}
                placeholder={t("photo_workflow.export.dest_placeholder")}
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

          {error && (
            <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2">
              {error}
            </div>
          )}

          {result && (
            <div className="space-y-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
              <div className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>
                  {t("photo_workflow.export.done", {
                    exported: result.exported,
                    failed: result.failed.length,
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
                onNavigate(result.destDir);
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
            disabled={running || !destDir.trim() || entries.length === 0}
            onClick={() => void handleExport()}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 font-medium disabled:opacity-50"
          >
            {running && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {running ? t("photo_workflow.export.running") : t("photo_workflow.export.start")}
          </button>
        </div>
      </div>
    </div>
  );
}

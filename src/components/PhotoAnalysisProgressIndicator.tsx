import { Scan } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PhotoAnalysisProgress } from "@/lib/photoAnalysis";

interface PhotoAnalysisProgressIndicatorProps {
  progress: PhotoAnalysisProgress;
}

export function PhotoAnalysisProgressIndicator({ progress }: PhotoAnalysisProgressIndicatorProps) {
  const { t } = useTranslation();
  if (progress.total <= 0) return null;

  const completed = Math.min(progress.completed, progress.total);
  const percentage = Math.round((completed / progress.total) * 100);
  const label = t(
    progress.isAnalyzing ? "common.photo_analysis_progress" : "common.photo_analysis_progress_done",
    { completed, total: progress.total }
  );

  return (
    <div
      className="text-muted-foreground hidden max-w-[190px] min-w-[148px] shrink-0 items-center gap-2 rounded-md border border-transparent px-1.5 py-1 sm:flex"
      role="status"
      aria-live="polite"
      aria-label={label}
      title={label}
    >
      <Scan className="text-primary h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2 text-[10px] leading-3">
          <span className="truncate">{t("common.photo_analysis_label")}</span>
          <span className="shrink-0 font-mono tabular-nums">
            {completed}/{progress.total}
          </span>
        </div>
        <div
          className="bg-muted mt-1 h-1.5 overflow-hidden rounded-full"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={completed}
          aria-valuetext={`${percentage}%`}
        >
          <div
            className="bg-primary h-full rounded-full transition-[width] duration-200 ease-out"
            style={{ width: `${percentage}%` }}
          />
        </div>
      </div>
    </div>
  );
}

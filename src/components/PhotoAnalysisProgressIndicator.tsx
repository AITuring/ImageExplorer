import { Scan } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PhotoAnalysisProgress } from "@/lib/photoAnalysis";

interface PhotoAnalysisProgressIndicatorProps {
  progress: PhotoAnalysisProgress;
}

const STAGE_ORDER = ["extracting-features", "estimating-focus", "grouping-views"] as const;

export function PhotoAnalysisProgressIndicator({ progress }: PhotoAnalysisProgressIndicatorProps) {
  const { t } = useTranslation();
  if (progress.total <= 0) return null;

  const stageIndex = progress.isAnalyzing
    ? Math.max(0, STAGE_ORDER.indexOf(progress.stage as (typeof STAGE_ORDER)[number]))
    : STAGE_ORDER.length;
  const stageFraction =
    progress.isAnalyzing && progress.stageTotal > 0
      ? Math.min(1, progress.stageCompleted / progress.stageTotal)
      : 1;
  const percentage = Math.round(
    ((Math.min(stageIndex, STAGE_ORDER.length - 1) + stageFraction) / STAGE_ORDER.length) * 100
  );
  const stageLabel = progress.isAnalyzing
    ? t(`common.photo_analysis_stage_${progress.stage}`)
    : t("common.photo_analysis_progress_done", { total: progress.total });
  const stageDetail = progress.isAnalyzing
    ? t(`common.photo_analysis_stage_${progress.stage}_detail`, {
        completed: progress.stageCompleted,
        total: progress.stageTotal,
      })
    : t("common.photo_analysis_progress_done", { total: progress.total });
  const label = t(
    progress.isAnalyzing ? "common.photo_analysis_progress" : "common.photo_analysis_progress_done",
    { stage: stageLabel, completed: progress.stageCompleted, total: progress.stageTotal }
  );

  return (
    <div
      className="text-muted-foreground hidden max-w-57.5 min-w-44 shrink-0 items-center gap-2 rounded-md border border-transparent px-1.5 py-1 sm:flex"
      role="status"
      aria-live="polite"
      aria-label={label}
      title={label}
    >
      <Scan className="text-primary h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2 text-[10px] leading-3">
          <span className="truncate">{t("common.photo_analysis_label")}</span>
          <span className="shrink-0 font-mono tabular-nums">{percentage}%</span>
        </div>
        <div className="mt-1 truncate text-[10px] leading-3">
          <span className="text-foreground">{stageLabel}</span>
          <span className="ml-1">{stageDetail}</span>
        </div>
        <div
          className="bg-muted mt-1 h-1.5 overflow-hidden rounded-full"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percentage}
          aria-valuetext={`${percentage}%`}
        >
          <div
            className="bg-primary h-full rounded-full transition-[width] duration-200 ease-out"
            style={{ width: `${percentage}%` }}
          />
        </div>
        <div className="mt-1 truncate text-[9px] leading-3 opacity-70">
          {t("common.photo_analysis_flow")}
        </div>
      </div>
    </div>
  );
}

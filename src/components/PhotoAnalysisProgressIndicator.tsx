import { Scan } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PhotoAnalysisProgress } from "@/lib/photoAnalysis";

interface PhotoAnalysisProgressIndicatorProps {
  progress: PhotoAnalysisProgress;
}

export function PhotoAnalysisProgressIndicator({ progress }: PhotoAnalysisProgressIndicatorProps) {
  const { t } = useTranslation();
  // 整理完成后自动收起顶部状态条，把垂直空间完全留给文件浏览区域。
  if (progress.total <= 0 || !progress.isAnalyzing) return null;

  const stageFraction =
    progress.stageTotal > 0 ? Math.min(1, progress.stageCompleted / progress.stageTotal) : 1;
  // Feature extraction accounts for ~92% of real wall-clock work; weight stages
  // accordingly so the top progress bar reflects true completion smoothly.
  const exactPercent =
    progress.stage === "extracting-features"
      ? stageFraction * 92
      : progress.stage === "estimating-focus"
        ? 92 + stageFraction * 3
        : progress.stage === "grouping-views"
          ? 95 + stageFraction * 5
          : 100;
  const percentage = Math.min(100, Math.round(exactPercent));
  const stageLabel = t(`common.photo_analysis_stage_${progress.stage}`);
  const stageDetail = t(`common.photo_analysis_stage_${progress.stage}_detail`, {
    completed: progress.stageCompleted,
    total: progress.stageTotal,
  });
  const label = t("common.photo_analysis_progress", {
    stage: stageLabel,
    completed: progress.stageCompleted,
    total: progress.stageTotal,
  });

  return (
    <div
      className="text-muted-foreground border-border/40 flex shrink-0 items-center gap-2 border-b px-3 py-1"
      role="status"
      aria-live="polite"
      aria-label={label}
      title={label}
    >
      <Scan className="text-primary h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="flex shrink-0 items-center gap-2 text-[10px] leading-3">
          <span className="truncate">{t("common.photo_analysis_label")}</span>
          <span className="shrink-0 font-mono tabular-nums">{percentage}%</span>
        </div>
        <div className="min-w-0 truncate text-[10px] leading-3">
          <span className="text-foreground">{stageLabel}</span>
          <span className="ml-1">{stageDetail}</span>
        </div>
        <div
          className="bg-muted ml-auto h-1.5 w-24 shrink-0 overflow-hidden rounded-full"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percentage}
          aria-valuetext={`${percentage}%`}
        >
          <div
            className="bg-primary h-full rounded-full transition-[width] duration-200 ease-out"
            style={{ width: `${Math.max(exactPercent > 0 ? 2 : 0, exactPercent).toFixed(1)}%` }}
          />
        </div>
      </div>
    </div>
  );
}

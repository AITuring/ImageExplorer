import { memo, useMemo } from "react";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PhotoHistogramData } from "@/lib/histogramAnalysis";

interface PhotoHistogramProps {
  histogram: PhotoHistogramData | null;
  showClippingOverlay?: boolean;
  onToggleClippingOverlay?: () => void;
  compact?: boolean;
}

function buildChannelPath(bins: Uint32Array, scalePeak: number, height: number): string {
  // Downsample 256 -> 64 smooth buckets for crisp, low-overhead SVG rendering
  const buckets = 64;
  const step = 256 / buckets;
  const parts: string[] = [`M 0 ${height}`];

  for (let i = 0; i < buckets; i++) {
    let sum = 0;
    const start = i * step;
    for (let j = 0; j < step; j++) {
      sum += bins[start + j];
    }
    const avg = sum / step;
    const norm = Math.min(1, avg / scalePeak);
    const x = ((i + 0.5) / buckets) * 256;
    const y = height - norm * (height - 2);
    parts.push(`L ${x.toFixed(1)} ${y.toFixed(1)}`);
  }

  parts.push(`L 256 ${height} Z`);
  return parts.join(" ");
}

export const PhotoHistogram = memo(function PhotoHistogram({
  histogram,
  showClippingOverlay = false,
  onToggleClippingOverlay,
  compact = false,
}: PhotoHistogramProps) {
  const { t } = useTranslation();
  const chartHeight = compact ? 44 : 64;

  const paths = useMemo(() => {
    if (!histogram) return null;
    return {
      r: buildChannelPath(histogram.r, histogram.scalePeak, chartHeight),
      g: buildChannelPath(histogram.g, histogram.scalePeak, chartHeight),
      b: buildChannelPath(histogram.b, histogram.scalePeak, chartHeight),
      luma: buildChannelPath(histogram.luma, histogram.scalePeak, chartHeight),
    };
  }, [chartHeight, histogram]);

  if (!histogram || !paths) {
    return null;
  }

  const highlightPct = (histogram.highlightClipRatio * 100).toFixed(1);
  const shadowPct = (histogram.shadowClipRatio * 100).toFixed(1);
  const hasHighlightClip = histogram.highlightClipRatio >= 0.002;
  const hasShadowClip = histogram.shadowClipRatio >= 0.002;

  return (
    <div
      className={`border-border/50 bg-secondary/20 rounded-lg border ${
        compact ? "px-2.5 py-1.5" : "p-3"
      }`}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px]">
        <span className="font-medium">{t("file_list.histogram.title")}</span>
        <div className="flex items-center gap-1.5 tabular-nums">
          <span
            className={`inline-flex items-center gap-1 ${
              hasShadowClip ? "font-medium text-blue-500" : "text-muted-foreground"
            }`}
            title={t("file_list.histogram.shadow_clip")}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
            {shadowPct}%
          </span>
          <span
            className={`inline-flex items-center gap-1 ${
              hasHighlightClip ? "font-medium text-red-500" : "text-muted-foreground"
            }`}
            title={t("file_list.histogram.highlight_clip")}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
            {highlightPct}%
          </span>
          {onToggleClippingOverlay && (
            <button
              type="button"
              onClick={onToggleClippingOverlay}
              aria-pressed={showClippingOverlay}
              title={t("file_list.histogram.toggle_clipping")}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                showClippingOverlay
                  ? "bg-red-500/20 text-red-600 dark:text-red-300"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              <AlertTriangle className="h-2.5 w-2.5" aria-hidden="true" />
              {t("file_list.histogram.clipping_short")}
            </button>
          )}
        </div>
      </div>

      <svg
        viewBox={`0 0 256 ${chartHeight}`}
        preserveAspectRatio="none"
        className={`bg-background/80 block w-full overflow-hidden rounded border border-black/10 dark:border-white/10 ${
          compact ? "h-11" : "h-16"
        }`}
        aria-label={t("file_list.histogram.title")}
      >
        {/* Subtle quartile exposure grid lines */}
        <line
          x1="64"
          y1="0"
          x2="64"
          y2={chartHeight}
          stroke="currentColor"
          strokeOpacity="0.1"
          strokeWidth="1"
        />
        <line
          x1="128"
          y1="0"
          x2="128"
          y2={chartHeight}
          stroke="currentColor"
          strokeOpacity="0.12"
          strokeWidth="1"
        />
        <line
          x1="192"
          y1="0"
          x2="192"
          y2={chartHeight}
          stroke="currentColor"
          strokeOpacity="0.1"
          strokeWidth="1"
        />
        <path d={paths.r} fill="rgba(239, 68, 68, 0.38)" />
        <path d={paths.g} fill="rgba(34, 197, 94, 0.38)" />
        <path d={paths.b} fill="rgba(59, 130, 246, 0.38)" />
        <path
          d={paths.luma}
          fill="rgba(161, 161, 170, 0.25)"
          stroke="rgba(161, 161, 170, 0.75)"
          strokeWidth="1"
        />
      </svg>
    </div>
  );
});

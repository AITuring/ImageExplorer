import { useMemo } from "react";
import { Crop, Image, Loader2, RotateCcw, ScanSearch } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SharpnessInspectorStatus } from "@/hooks/useSharpnessInspector";
import type { NormalizedRect, SharpnessMaskResult } from "@/lib/sharpnessAnalysis";

interface SharpnessInspectorToolbarProps {
  enabled: boolean;
  status: SharpnessInspectorStatus;
  selectionMode: boolean;
  selection: NormalizedRect | null;
  result: SharpnessMaskResult | null;
  onToggle: () => void;
  onAnalyzeFullImage: () => void;
  onResetSelection: () => void;
}

export function SharpnessInspectorToolbar({
  enabled,
  status,
  selectionMode,
  selection,
  result,
  onToggle,
  onAnalyzeFullImage,
  onResetSelection,
}: SharpnessInspectorToolbarProps) {
  const { t, i18n } = useTranslation();
  const percentageFormatter = useMemo(
    () =>
      new Intl.NumberFormat(i18n.resolvedLanguage, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
    [i18n.resolvedLanguage]
  );
  const statusText = (() => {
    switch (status) {
      case "waiting":
        return t("common.quick_look.sharpness_preparing");
      case "analyzing":
        return t(
          selection
            ? "common.quick_look.sharpness_analyzing"
            : "common.quick_look.sharpness_analyzing_full"
        );
      case "ready":
        return t("common.quick_look.sharpness_ready", {
          value: percentageFormatter.format(Math.max(0.1, (result?.highlightedRatio ?? 0) * 100)),
        });
      case "empty":
        return t(
          selection ? "common.quick_look.sharpness_empty" : "common.quick_look.sharpness_empty_full"
        );
      case "too-small":
        return t("common.quick_look.sharpness_too_small");
      case "error":
        return t("common.quick_look.sharpness_error");
      case "selecting":
      default:
        return t("common.quick_look.sharpness_select");
    }
  })();

  return (
    <div className="pointer-events-none absolute inset-x-2 top-2 z-40 flex justify-center">
      <div className="pointer-events-auto grid max-w-full grid-cols-1 overflow-hidden rounded-lg border border-white/15 bg-black/80 text-[11px] text-white shadow-lg backdrop-blur-md">
        <div className="flex min-w-0 flex-wrap items-center justify-center gap-1 p-1">
          <button
            type="button"
            aria-pressed={enabled}
            aria-label={
              enabled
                ? t("common.quick_look.sharpness_disable")
                : t("common.quick_look.sharpness_enable")
            }
            title={t("common.quick_look.sharpness_hint")}
            onClick={onToggle}
            className={`flex h-8 shrink-0 touch-manipulation items-center gap-1.5 rounded-md px-2 font-medium transition-colors focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none motion-reduce:transition-none ${enabled ? "bg-white/18 text-white" : "text-white/85 hover:bg-white/12 hover:text-white"}`}
          >
            <ScanSearch className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t("common.quick_look.sharpness_tool")}</span>
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${enabled ? "bg-rose-400" : "bg-white/35"}`}
            />
          </button>

          {enabled ? (
            <>
              <span className="h-4 w-px shrink-0 bg-white/18" aria-hidden="true" />
              <button
                type="button"
                onClick={onAnalyzeFullImage}
                aria-pressed={!selectionMode && !selection}
                aria-label={t("common.quick_look.sharpness_full_image")}
                className={`flex h-8 shrink-0 touch-manipulation items-center gap-1 rounded-md px-2 transition-colors hover:bg-white/12 hover:text-white focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none motion-reduce:transition-none ${!selectionMode && !selection ? "bg-white/18 text-white" : "text-white/85"}`}
                title={t("common.quick_look.sharpness_full_image")}
              >
                <Image className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{t("common.quick_look.sharpness_full_image_short")}</span>
              </button>
              <button
                type="button"
                onClick={onResetSelection}
                aria-pressed={selectionMode}
                aria-label={
                  selection
                    ? t("common.quick_look.sharpness_reselect")
                    : t("common.quick_look.sharpness_select_area")
                }
                className={`flex h-8 shrink-0 touch-manipulation items-center gap-1 rounded-md px-2 transition-colors hover:bg-white/12 hover:text-white focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none motion-reduce:transition-none ${selectionMode ? "bg-white/18 text-white" : "text-white/85"}`}
                title={
                  selection
                    ? t("common.quick_look.sharpness_reselect")
                    : t("common.quick_look.sharpness_select_area")
                }
              >
                {selection ? (
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Crop className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                <span>
                  {selection
                    ? t("common.quick_look.sharpness_reselect")
                    : t("common.quick_look.sharpness_select_area")}
                </span>
              </button>
            </>
          ) : null}
        </div>

        {enabled ? (
          <span
            className="max-w-[min(28rem,calc(100vw-2rem))] min-w-0 border-t border-white/12 px-2.5 py-1 text-center leading-4 text-pretty text-white/80"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {status === "waiting" || status === "analyzing" ? (
              <Loader2
                className="mr-1 inline h-3 w-3 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : null}
            {statusText}
          </span>
        ) : null}
      </div>
    </div>
  );
}

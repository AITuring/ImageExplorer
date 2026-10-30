import { useTranslation } from "react-i18next";
import type { VisibleSharpness } from "@/hooks/useVisibleSharpness";
import type { PhotoMetadataSummary } from "@/lib/photoMetadata";

export function SharpnessBadge({ verdict }: { verdict?: VisibleSharpness }) {
  const { t } = useTranslation();
  const state = verdict ?? "pending";
  return (
    <span
      className={`finder-sharpness-tag inline-flex shrink-0 items-center rounded px-1 py-0.5 text-[10px] leading-4 font-medium ${
        state === "sharp"
          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
          : state === "soft"
            ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
            : "bg-muted text-muted-foreground"
      }`}
      title={t("common.photo_visible_note")}
    >
      {t(`common.photo_visible_${state}_short`)}
    </span>
  );
}

export function PhotoParameters({
  summary,
  compact = false,
}: {
  summary: PhotoMetadataSummary | null;
  compact?: boolean;
}) {
  const description = [
    summary?.dimensions,
    summary?.exposure.join(" · "),
    summary?.camera.join(" · "),
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div
      className={`text-muted-foreground text-[11px] leading-4 tabular-nums ${compact ? "truncate" : "space-y-0.5"}`}
      title={description}
    >
      {!compact && summary?.dimensions && <div>{summary.dimensions}</div>}
      <div className={compact ? "truncate" : "break-words"}>
        {summary?.exposure.join(" · ") || "—"}
      </div>
      {!compact && !!summary?.camera.length && (
        <div className="break-words">{summary.camera.join(" · ")}</div>
      )}
    </div>
  );
}

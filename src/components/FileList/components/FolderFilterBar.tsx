import { memo } from "react";
import { Filter, Layers, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { FINDER_TAG_PRESETS } from "@/lib/finderTags";
import {
  DEFAULT_FOLDER_FILTER,
  hasActiveFolderFilter,
  type FolderFilterState,
  type FolderFormatFilter,
  type FolderSharpnessFilter,
} from "@/lib/folderFilter";

interface FolderFilterBarProps {
  filter: FolderFilterState;
  onChange: (next: FolderFilterState) => void;
  totalCount: number;
  filteredCount: number;
  pairCount: number;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  onClose?: () => void;
}

export const FolderFilterBar = memo(function FolderFilterBar({
  filter,
  onChange,
  totalCount,
  filteredCount,
  pairCount,
  inputRef,
  onClose,
}: FolderFilterBarProps) {
  const { t } = useTranslation();
  const isActive = hasActiveFolderFilter(filter);

  const setFormat = (format: FolderFormatFilter) =>
    onChange({ ...filter, format: filter.format === format ? "all" : format });

  const setSharpness = (sharpness: FolderSharpnessFilter) =>
    onChange({ ...filter, sharpness: filter.sharpness === sharpness ? "all" : sharpness });

  const toggleTag = (tagId: string) =>
    onChange({ ...filter, tagId: filter.tagId === tagId ? null : tagId });

  return (
    <div className="border-border/50 bg-muted/25 mb-2 flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs">
      <div className="relative flex min-w-36 flex-1 items-center sm:max-w-52">
        <Filter className="text-muted-foreground pointer-events-none absolute left-2 h-3.5 w-3.5" />
        <input
          ref={inputRef}
          type="text"
          value={filter.query}
          onChange={(event) => onChange({ ...filter, query: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              if (filter.query) {
                onChange({ ...filter, query: "" });
              } else {
                event.currentTarget.blur();
              }
            }
          }}
          placeholder={t("file_list.filter_placeholder")}
          aria-label={t("file_list.filter_placeholder")}
          className="bg-background/80 border-border/60 placeholder:text-muted-foreground h-6 w-full rounded border pr-6 pl-7 text-xs outline-none focus-visible:ring-1"
        />
        {filter.query && (
          <button
            type="button"
            onClick={() => onChange({ ...filter, query: "" })}
            aria-label={t("file_list.filter_clear")}
            className="text-muted-foreground hover:text-foreground absolute right-1.5 rounded p-0.5"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Format chips */}
      <div
        className="flex items-center gap-1"
        role="group"
        aria-label={t("file_list.filter_format")}
      >
        {(
          [
            ["raw", "RAW"],
            ["jpeg", "JPEG"],
            ["video", t("search.filter_video")],
          ] as const
        ).map(([format, label]) => (
          <button
            key={format}
            type="button"
            aria-pressed={filter.format === format}
            onClick={() => setFormat(format)}
            className={`rounded-full px-2 py-0.5 text-[11px] transition-colors ${
              filter.format === format
                ? "bg-primary/15 text-primary font-medium"
                : "text-muted-foreground hover:bg-accent"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <span className="bg-border/60 h-3.5 w-[1px]" aria-hidden="true" />

      {/* Sharpness chips */}
      <div
        className="flex items-center gap-1"
        role="group"
        aria-label={t("common.photo_sharpness_toggle")}
      >
        <button
          type="button"
          aria-pressed={filter.sharpness === "sharp"}
          onClick={() => setSharpness("sharp")}
          className={`rounded-full px-2 py-0.5 text-[11px] transition-colors ${
            filter.sharpness === "sharp"
              ? "bg-emerald-500/20 font-medium text-emerald-700 dark:text-emerald-300"
              : "text-muted-foreground hover:bg-accent"
          }`}
        >
          {t("common.photo_visible_sharp_short")}
        </button>
        <button
          type="button"
          aria-pressed={filter.sharpness === "soft"}
          onClick={() => setSharpness("soft")}
          className={`rounded-full px-2 py-0.5 text-[11px] transition-colors ${
            filter.sharpness === "soft"
              ? "bg-amber-500/20 font-medium text-amber-700 dark:text-amber-300"
              : "text-muted-foreground hover:bg-accent"
          }`}
        >
          {t("common.photo_visible_soft_short")}
        </button>
      </div>

      <span className="bg-border/60 h-3.5 w-[1px]" aria-hidden="true" />

      {/* Finder Tag color filter dots */}
      <div className="flex items-center gap-1" role="group" aria-label={t("tags.section")}>
        {FINDER_TAG_PRESETS.map((preset) => {
          const active = filter.tagId === preset.id;
          const label = t(preset.labelKey);
          return (
            <button
              key={preset.id}
              type="button"
              title={label}
              aria-label={label}
              aria-pressed={active}
              onClick={() => toggleTag(preset.id)}
              className={`flex h-4 w-4 items-center justify-center rounded-full transition-transform hover:scale-110 ${
                active
                  ? "ring-foreground ring-offset-background ring-2 ring-offset-1"
                  : "opacity-75 ring-1 ring-black/15 hover:opacity-100"
              }`}
              style={{ backgroundColor: preset.color }}
            />
          );
        })}
      </div>

      <span className="bg-border/60 h-3.5 w-[1px]" aria-hidden="true" />

      {/* RAW+JPG pair stacking toggle */}
      <button
        type="button"
        aria-pressed={filter.pairRawJpeg}
        onClick={() => onChange({ ...filter, pairRawJpeg: !filter.pairRawJpeg })}
        title={t("file_list.pair_raw_jpeg_hint")}
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors ${
          filter.pairRawJpeg
            ? "bg-primary/15 text-primary font-medium"
            : "text-muted-foreground hover:bg-accent"
        }`}
      >
        <Layers className="h-3 w-3" aria-hidden="true" />
        <span>RAW+JPG{filter.pairRawJpeg && pairCount > 0 ? ` (${pairCount})` : ""}</span>
      </button>

      <div className="ml-auto flex items-center gap-2">
        {isActive && (
          <>
            <span className="text-muted-foreground text-[11px] tabular-nums">
              {filteredCount} / {totalCount}
            </span>
            <button
              type="button"
              onClick={() =>
                onChange({ ...DEFAULT_FOLDER_FILTER, pairRawJpeg: filter.pairRawJpeg })
              }
              className="text-primary text-[11px] hover:underline"
            >
              {t("file_list.filter_clear")}
            </button>
          </>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.cancel")}
            className="text-muted-foreground hover:text-foreground rounded p-0.5"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
});

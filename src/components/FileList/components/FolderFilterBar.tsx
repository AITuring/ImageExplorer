import { memo } from "react";
import {
  Camera,
  Check,
  CircleDashed,
  FastForward,
  FileCode2,
  Filter,
  FolderOutput,
  ImageDown,
  Layers,
  Sparkles,
  Star,
  X,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { FINDER_TAG_PRESETS } from "@/lib/finderTags";
import {
  DEFAULT_FOLDER_FILTER,
  hasActiveFolderFilter,
  type FolderFilterState,
  type FolderFlagFilter,
  type FolderFormatFilter,
  type FolderSharpnessFilter,
} from "@/lib/folderFilter";

interface FolderFilterBarProps {
  filter: FolderFilterState;
  onChange: (next: FolderFilterState) => void;
  totalCount: number;
  filteredCount: number;
  pairCount: number;
  cameraOptions?: string[];
  lensOptions?: string[];
  burstGroupCount?: number;
  autoAdvance?: boolean;
  onToggleAutoAdvance?: () => void;
  sortByCaptured?: boolean;
  onToggleSortByCaptured?: () => void;
  onAutoPickBest?: () => void;
  onExportXmp?: () => void;
  onExportFiltered?: () => void;
  onBatchExport?: () => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  onClose?: () => void;
}

export const FolderFilterBar = memo(function FolderFilterBar({
  filter,
  onChange,
  totalCount,
  filteredCount,
  pairCount,
  cameraOptions = [],
  lensOptions = [],
  burstGroupCount = 0,
  autoAdvance = false,
  onToggleAutoAdvance,
  sortByCaptured = false,
  onToggleSortByCaptured,
  onAutoPickBest,
  onExportXmp,
  onExportFiltered,
  onBatchExport,
  inputRef,
  onClose,
}: FolderFilterBarProps) {
  const { t } = useTranslation();
  const isActive = hasActiveFolderFilter(filter);

  const setFormat = (format: FolderFormatFilter) =>
    onChange({ ...filter, format: filter.format === format ? "all" : format });

  const setSharpness = (sharpness: FolderSharpnessFilter) =>
    onChange({ ...filter, sharpness: filter.sharpness === sharpness ? "all" : sharpness });

  const setFlag = (flag: FolderFlagFilter) =>
    onChange({ ...filter, flag: filter.flag === flag ? "all" : flag });

  const toggleTag = (tagId: string) =>
    onChange({ ...filter, tagId: filter.tagId === tagId ? null : tagId });

  return (
    <div
      onMouseDown={(event) => {
        if ((event.target as Element | null)?.closest("button")) {
          event.preventDefault();
        }
      }}
      className="border-border/50 bg-muted/25 mb-2 flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs"
    >
      <div className="relative flex min-w-32 flex-1 items-center sm:max-w-44">
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

      {/* Culling Flag & Min Rating */}
      <div
        className="flex items-center gap-1"
        role="group"
        aria-label={t("file_list.culling.pick")}
      >
        <button
          type="button"
          aria-pressed={filter.flag === "pick"}
          onClick={() => setFlag("pick")}
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors ${
            filter.flag === "pick"
              ? "bg-emerald-500/20 font-medium text-emerald-700 dark:text-emerald-300"
              : "text-muted-foreground hover:bg-accent"
          }`}
        >
          <Check className="h-3 w-3" aria-hidden="true" />
          {t("file_list.culling.pick")}
        </button>
        <button
          type="button"
          aria-pressed={filter.flag === "reject"}
          onClick={() => setFlag("reject")}
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors ${
            filter.flag === "reject"
              ? "bg-destructive/20 text-destructive font-medium"
              : "text-muted-foreground hover:bg-accent"
          }`}
        >
          <XCircle className="h-3 w-3" aria-hidden="true" />
          {t("file_list.culling.reject")}
        </button>
        <button
          type="button"
          aria-pressed={filter.flag === "unflagged"}
          onClick={() => setFlag("unflagged")}
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors ${
            filter.flag === "unflagged"
              ? "bg-primary/15 text-primary font-medium"
              : "text-muted-foreground hover:bg-accent"
          }`}
        >
          <CircleDashed className="h-3 w-3" aria-hidden="true" />
          {t("file_list.culling.unflagged")}
        </button>
        <button
          type="button"
          onClick={() =>
            onChange({ ...filter, minRating: filter.minRating >= 5 ? 0 : filter.minRating + 1 })
          }
          aria-pressed={filter.minRating > 0}
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors ${
            filter.minRating > 0
              ? "bg-amber-500/20 font-medium text-amber-700 dark:text-amber-300"
              : "text-muted-foreground hover:bg-accent"
          }`}
        >
          <Star className="h-3 w-3 fill-current" aria-hidden="true" />
          <span>
            {filter.minRating > 0
              ? t("file_list.culling.rating_min", { count: filter.minRating })
              : t("file_list.culling.rating_any")}
          </span>
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

      {/* Dynamic EXIF Camera / Lens dropdowns when metadata is available */}
      {cameraOptions.length > 1 && (
        <select
          value={filter.cameraModel ?? ""}
          onChange={(event) => {
            onChange({ ...filter, cameraModel: event.target.value || null });
            event.currentTarget.blur();
          }}
          aria-label={t("file_list.details.model")}
          className="bg-background/80 border-border/60 h-6 max-w-36 rounded border px-1.5 text-[11px] outline-none"
        >
          <option value="">{t("file_list.culling.camera_all")}</option>
          {cameraOptions.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      )}
      {lensOptions.length > 1 && (
        <select
          value={filter.lensModel ?? ""}
          onChange={(event) => {
            onChange({ ...filter, lensModel: event.target.value || null });
            event.currentTarget.blur();
          }}
          aria-label={t("file_list.details.lens")}
          className="bg-background/80 border-border/60 h-6 max-w-40 rounded border px-1.5 text-[11px] outline-none"
        >
          <option value="">{t("file_list.culling.lens_all")}</option>
          {lensOptions.map((lens) => (
            <option key={lens} value={lens}>
              {lens}
            </option>
          ))}
        </select>
      )}

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

      {/* Sort by EXIF Capture Time */}
      {onToggleSortByCaptured && (
        <button
          type="button"
          aria-pressed={sortByCaptured}
          onClick={onToggleSortByCaptured}
          title={t("file_list.culling.sort_captured_hint")}
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors ${
            sortByCaptured
              ? "bg-primary/15 text-primary font-medium"
              : "text-muted-foreground hover:bg-accent"
          }`}
        >
          <Camera className="h-3 w-3" aria-hidden="true" />
          <span>{t("file_list.culling.sort_captured")}</span>
        </button>
      )}

      {/* Auto-advance culling toggle */}
      {onToggleAutoAdvance && (
        <button
          type="button"
          aria-pressed={autoAdvance}
          onClick={onToggleAutoAdvance}
          title={t("file_list.culling.auto_advance_hint")}
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors ${
            autoAdvance
              ? "bg-primary/15 text-primary font-medium"
              : "text-muted-foreground hover:bg-accent"
          }`}
        >
          <FastForward className="h-3 w-3" aria-hidden="true" />
          <span>{t("file_list.culling.auto_advance")}</span>
        </button>
      )}

      {/* Auto-Pick Best for burst similarity groups */}
      {burstGroupCount > 0 && onAutoPickBest && (
        <button
          type="button"
          onClick={onAutoPickBest}
          title={t("file_list.culling.auto_pick_best_hint")}
          className="bg-primary/10 text-primary hover:bg-primary/20 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors"
        >
          <Sparkles className="h-3 w-3" aria-hidden="true" />
          <span>
            {t("file_list.culling.auto_pick_best")} ({burstGroupCount})
          </span>
        </button>
      )}

      {/* Export XMP sidecars */}
      {onExportXmp && (
        <button
          type="button"
          onClick={onExportXmp}
          title={t("file_list.culling.export_xmp_hint")}
          className="text-muted-foreground hover:bg-accent hover:text-foreground inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors"
        >
          <FileCode2 className="h-3 w-3" aria-hidden="true" />
          <span>{t("file_list.culling.export_xmp")}</span>
        </button>
      )}

      {/* Batch Transcode Export */}
      {filteredCount > 0 && onBatchExport && (
        <button
          type="button"
          onClick={onBatchExport}
          title={t("photo_workflow.export.title")}
          className="text-muted-foreground hover:bg-accent hover:text-foreground inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors"
        >
          <ImageDown className="h-3 w-3" aria-hidden="true" />
          <span>{t("context_menu.batch_export").replace(/\.\.\.$/, "")}</span>
        </button>
      )}

      {/* Export filtered photos to folder */}
      {isActive && filteredCount > 0 && onExportFiltered && (
        <button
          type="button"
          onClick={onExportFiltered}
          title={t("file_list.culling.export_filtered_hint")}
          className="bg-primary/15 text-primary hover:bg-primary/25 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors"
        >
          <FolderOutput className="h-3 w-3" aria-hidden="true" />
          <span>{t("file_list.culling.export_filtered")}</span>
        </button>
      )}

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

import { memo, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { FileEntry } from "@/types/index";
import { FileThumbnail } from "@/components/FileThumbnail";
import { FocusRegionOverlay } from "@/components/FocusRegionOverlay";
import { getContainedFocusRegionPosition } from "@/lib/focusPoint";
import type { PhotoAnalysisRecord } from "@/lib/photoAnalysis";
import { getCameraAfRegions } from "@/lib/cameraAfMetadata";
import { getPhotoMetadataSummary } from "@/lib/photoMetadata";
import { usePhotoMetadata } from "@/hooks/usePhotoMetadata";
import { useCameraAfMetadata } from "@/hooks/useCameraAfMetadata";
import type { VisibleSharpness } from "@/hooks/useVisibleSharpness";
import { Input } from "@/components/ui/input";

interface FileGridItemProps {
  entry: FileEntry;
  isSelected: boolean;
  isFocused?: boolean;
  isEditing: boolean;
  editValue: string;
  onEditValueChange: (value: string) => void;
  onSubmitRename: () => void;
  onCancelRename: () => void;
  onClick: (e: React.MouseEvent) => void;
  onNameClick?: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onMove?: (source: string, target: string) => void;
  photoAnalysis?: PhotoAnalysisRecord;
  visibleSharpness?: VisibleSharpness;
  photoGroupColor?: string;
  photoAnalysisEnabled?: boolean;
  isScrolling?: boolean;
  isInViewport?: boolean;
}

export const FileGridItem = memo(function FileGridItem({
  entry,
  isSelected,
  isFocused = false,
  isEditing,
  editValue,
  onEditValueChange,
  onSubmitRename,
  onCancelRename,
  onClick,
  onNameClick,
  onDoubleClick,
  photoAnalysis,
  visibleSharpness,
  photoGroupColor,
  photoAnalysisEnabled = false,
  isScrolling = false,
  isInViewport = true,
}: FileGridItemProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();
  // Metadata/ExifTool reads are useful after the user stops, but starting one
  // for every newly mounted overscan row makes fast scrolling compete with
  // thumbnail decoding.
  const canLoadViewportData = isInViewport && !isScrolling;
  const photoMetadata = usePhotoMetadata(entry, canLoadViewportData);
  const cameraAfMetadata = useCameraAfMetadata(entry, photoAnalysisEnabled && canLoadViewportData);
  const metadataSummary = getPhotoMetadataSummary(photoMetadata);
  const thumbnailSize = photoAnalysisEnabled ? 144 : 80;
  const cameraAfRegions = getCameraAfRegions(cameraAfMetadata);
  const focusRegions =
    cameraAfRegions ??
    (photoAnalysis &&
    photoAnalysis.imageWidth > 0 &&
    photoAnalysis.imageHeight > 0 &&
    photoAnalysis.focusAnalysis.kind !== "full-frame"
      ? photoAnalysis.focusAnalysis.regions
      : []);
  const focusOverlayVariant = cameraAfRegions ? "camera" : "estimate";

  useEffect(() => {
    if (!isEditing) return;
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [isEditing]);

  return (
    <div
      className={`group flex cursor-default flex-col items-center rounded-md p-2 transition-colors ${
        isSelected
          ? "bg-accent/80 ring-primary/20 ring-1"
          : "hover:bg-accent/60 hover:ring-border/60 ring-1 ring-transparent"
      } ${isFocused ? "outline-primary outline outline-1 outline-offset-[-1px]" : ""}`}
      style={!isSelected && photoGroupColor ? { backgroundColor: photoGroupColor } : undefined}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <div
        className="relative mb-1 flex max-w-full items-center justify-center overflow-hidden"
        style={{ width: thumbnailSize, height: thumbnailSize }}
      >
        <FileThumbnail
          entry={entry}
          size={thumbnailSize}
          isScrolling={isScrolling}
          isInViewport={isInViewport}
          className="h-full w-full rounded-md object-contain"
          fallbackClassName={
            entry.is_dir ? "h-16 w-16 text-blue-500" : "text-muted-foreground h-16 w-16"
          }
        />
        {photoAnalysis &&
          focusRegions.map((region) => (
            <FocusRegionOverlay
              key={`${region.x}-${region.y}-${region.width}-${region.height}`}
              variant={focusOverlayVariant}
              showCenterPoint={cameraAfRegions !== null && !cameraAfMetadata?.exact}
              position={getContainedFocusRegionPosition({
                region,
                containerWidth: thumbnailSize,
                containerHeight: thumbnailSize,
                imageWidth: photoAnalysis.imageWidth,
                imageHeight: photoAnalysis.imageHeight,
              })}
            />
          ))}
      </div>
      {isEditing ? (
        <Input
          ref={inputRef}
          value={editValue}
          onChange={(e) => onEditValueChange(e.target.value)}
          onBlur={onSubmitRename}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              onSubmitRename();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              onCancelRename();
            }
          }}
          onClick={(e) => e.stopPropagation()}
          autoFocus
          className="h-6 w-full border-blue-400 bg-white/90 px-1.5 py-0.5 text-center text-xs shadow-sm focus-visible:border-blue-500 focus-visible:ring-1 focus-visible:ring-blue-400/50 focus-visible:ring-offset-0 dark:bg-gray-800/90"
        />
      ) : (
        <div
          className={`w-full text-center ${onNameClick ? "cursor-text" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            if (onNameClick) {
              onNameClick(e);
            } else {
              onClick(e);
            }
          }}
        >
          <div className="flex w-full min-w-0 items-center justify-center gap-1">
            <span
              className={`min-w-0 truncate rounded px-0.5 text-xs font-medium ${
                isSelected ? "bg-primary/10" : ""
              }`}
              title={entry.name}
            >
              {entry.name}
            </span>
            {photoAnalysisEnabled && !entry.is_dir && (
              <span
                className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-medium ${
                  visibleSharpness === "sharp"
                    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                    : visibleSharpness === "soft"
                      ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                      : "bg-muted text-muted-foreground"
                }`}
                title={t("common.photo_visible_note")}
              >
                {visibleSharpness === "sharp"
                  ? t("common.photo_visible_sharp_short")
                  : visibleSharpness === "soft"
                    ? t("common.photo_visible_soft_short")
                    : visibleSharpness === "unavailable"
                      ? t("common.photo_visible_unavailable_short")
                      : t("common.photo_visible_pending_short")}
              </span>
            )}
          </div>
          {cameraAfRegions === null && photoAnalysis?.focusAnalysis.kind === "full-frame" && (
            <div
              className="mt-1 max-w-full truncate px-1 text-[9px] leading-3 text-cyan-700/80 dark:text-cyan-200/80"
              title={t("common.quick_look.focus_full_frame")}
              aria-label={t("common.quick_look.focus_full_frame")}
            >
              {t("common.quick_look.focus_full_frame")}
            </div>
          )}
          {cameraAfMetadata?.source === "camera-maker-note" &&
            cameraAfMetadata.regions.length > 0 && (
              <div
                className="mt-1 max-w-full truncate px-1 text-[9px] leading-3 text-cyan-700/90 dark:text-cyan-200/90"
                title={cameraAfMetadata.note ?? t("common.quick_look.focus_camera_af")}
                aria-label={t("common.quick_look.focus_camera_af")}
              >
                {t("common.quick_look.focus_camera_af")}
              </div>
            )}
          {metadataSummary && (
            <div
              className="text-foreground/70 mt-0.5 flex w-full flex-col items-center gap-0.5 px-1 text-[10px] leading-3.5"
              title={[
                metadataSummary.dimensions,
                metadataSummary.exposure.join(" · "),
                ...metadataSummary.camera,
              ]
                .filter(Boolean)
                .join("\n")}
              aria-label={[
                metadataSummary.dimensions,
                metadataSummary.exposure.join(", "),
                ...metadataSummary.camera,
              ]
                .filter(Boolean)
                .join(", ")}
            >
              {metadataSummary.dimensions && (
                <div className="font-mono leading-4 tabular-nums">{metadataSummary.dimensions}</div>
              )}
              {metadataSummary.exposure.length > 0 && (
                <div className="flex max-w-full flex-wrap justify-center gap-x-1.5 gap-y-0.5 text-center font-medium tabular-nums">
                  {metadataSummary.exposure.map((value) => (
                    <span key={value} className="whitespace-nowrap">
                      {value}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

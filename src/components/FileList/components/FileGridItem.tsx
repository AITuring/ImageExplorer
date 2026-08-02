import { memo, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { FileEntry } from "@/types/index";
import { FileThumbnail } from "@/components/FileThumbnail";
import { FocusRegionOverlay } from "@/components/FocusRegionOverlay";
import { getContainedFocusRegionPosition } from "@/lib/focusPoint";
import type { PhotoAnalysisRecord } from "@/lib/photoAnalysis";
import { getPhotoMetadataSummary } from "@/lib/photoMetadata";
import { usePhotoMetadata } from "@/hooks/usePhotoMetadata";
import { Input } from "@/components/ui/input";

interface FileGridItemProps {
  entry: FileEntry;
  isSelected: boolean;
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
  photoGroupColor?: string;
}

export const FileGridItem = memo(function FileGridItem({
  entry,
  isSelected,
  isEditing,
  editValue,
  onEditValueChange,
  onSubmitRename,
  onCancelRename,
  onClick,
  onNameClick,
  onDoubleClick,
  photoAnalysis,
  photoGroupColor,
}: FileGridItemProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();
  const photoMetadata = usePhotoMetadata(entry);
  const metadataSummary = getPhotoMetadataSummary(photoMetadata);
  const thumbnailSize = 80;
  const focusRegions =
    photoAnalysis &&
    photoAnalysis.imageWidth > 0 &&
    photoAnalysis.imageHeight > 0 &&
    photoAnalysis.focusAnalysis.kind !== "full-frame"
      ? photoAnalysis.focusAnalysis.regions
      : [];

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
      className={`group flex cursor-default flex-col items-center rounded-md p-3 transition-colors ${
        isSelected
          ? "bg-accent/80 ring-primary/20 ring-1"
          : "hover:bg-accent/60 hover:ring-border/60 ring-1 ring-transparent"
      }`}
      style={!isSelected && photoGroupColor ? { backgroundColor: photoGroupColor } : undefined}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <div className="relative mb-2 flex h-20 w-20 items-center justify-center overflow-hidden">
        <FileThumbnail
          entry={entry}
          size={thumbnailSize}
          className="h-20 w-20 rounded-md object-contain"
          fallbackClassName={
            entry.is_dir ? "h-16 w-16 text-blue-500" : "text-muted-foreground h-16 w-16"
          }
        />
        {photoAnalysis &&
          focusRegions.map((region) => (
            <FocusRegionOverlay
              key={`${region.x}-${region.y}-${region.width}-${region.height}`}
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
          <span
            className={`line-clamp-2 rounded px-1 text-xs font-medium break-all ${
              isSelected ? "bg-primary/10" : ""
            }`}
            title={entry.name}
          >
            {entry.name}
          </span>
          {photoAnalysis?.focusAnalysis.kind === "full-frame" && (
            <div
              className="mt-1 max-w-full truncate px-1 text-[9px] leading-3 text-cyan-700/80 dark:text-cyan-200/80"
              title={t("common.quick_look.focus_full_frame")}
              aria-label={t("common.quick_look.focus_full_frame")}
            >
              {t("common.quick_look.focus_full_frame")}
            </div>
          )}
          {metadataSummary && (
            <div
              className="text-foreground/70 mt-1 flex w-full flex-col items-center gap-0.5 px-1 text-[10px] leading-3.5"
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
              {metadataSummary.camera.map((value) => (
                <div
                  key={value}
                  className="w-full max-w-full truncate text-center leading-4 whitespace-nowrap"
                  title={value}
                >
                  {value}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

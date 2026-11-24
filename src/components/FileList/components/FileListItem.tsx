import { SharpnessBadge, PhotoParameters } from "./PhotoDetails";
import { usePhotoMetadata } from "@/hooks/usePhotoMetadata";
import { getPhotoMetadataSummary } from "@/lib/photoMetadata";
import { isAnalyzablePhoto } from "@/lib/photoAnalysis";
import type { VisibleSharpness } from "@/hooks/useVisibleSharpness";
import { memo, useEffect, useRef } from "react";
import { Check, Star, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FileEntry } from "@/types/index";
import type { ListColumnVisibility, ListColumnWidths } from "@/stores/viewMode";
import type { PhotoCullingState } from "@/lib/photoCulling";
import { CompactFileThumbnail } from "./CompactFileThumbnail";
import { FinderTagDots } from "@/components/FinderTagDots";
import { Input } from "@/components/ui/input";
import { formatFileSize, formatDate } from "@/utils/format";

interface FileListItemProps {
  entry: FileEntry;
  index?: number;
  visibleSharpness?: VisibleSharpness;
  isInViewport?: boolean;
  isScrolling?: boolean;
  isSelected: boolean;
  isFocused?: boolean;
  isEditing: boolean;
  editValue: string;
  onEditValueChange: (value: string) => void;
  onSubmitRename: () => void;
  onCancelRename: () => void;
  onClick?: (e: React.MouseEvent) => void;
  onNameClick?: (e: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  onItemClick?: (entry: FileEntry, index: number, e: React.MouseEvent) => void;
  onItemNameClick?: (entry: FileEntry, index: number, e: React.MouseEvent) => void;
  onItemDoubleClick?: (entry: FileEntry) => void;
  onMove?: (source: string, target: string) => void;
  columnWidths?: ListColumnWidths;
  columnVisibility?: ListColumnVisibility;
  pairedBadge?: string | null;
  cullingState?: PhotoCullingState;
}

export const FileListItem = memo(function FileListItem({
  entry,
  index = 0,
  visibleSharpness,
  isInViewport = true,
  isScrolling = false,
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
  onItemClick,
  onItemNameClick,
  onItemDoubleClick,
  columnWidths,
  columnVisibility,
  pairedBadge,
  cullingState,
}: FileListItemProps) {
  const { t } = useTranslation();
  const metadata = usePhotoMetadata(entry, isInViewport && !isScrolling);
  const summary = getPhotoMetadataSummary(metadata);
  const isPhoto = isAnalyzablePhoto(entry);
  const inputRef = useRef<HTMLInputElement>(null);

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
      data-selected={isSelected}
      className={`finder-list-row flex w-full cursor-default items-center rounded-md p-2 text-sm transition-colors ${
        isSelected ? "bg-accent/80 ring-primary/20 ring-1" : "hover:bg-accent/60 focus:bg-accent/60"
      } ${isFocused ? "outline-primary outline outline-1 outline-offset-[-1px]" : ""} ${
        cullingState?.flag === "reject" ? "opacity-55" : ""
      }`}
      onClick={(e) => {
        if (onItemClick) onItemClick(entry, index, e);
        else onClick?.(e);
      }}
      onDoubleClick={() => {
        if (onItemDoubleClick) onItemDoubleClick(entry);
        else onDoubleClick?.();
      }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <CompactFileThumbnail entry={entry} isInViewport={isInViewport} isScrolling={isScrolling} />
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
            className="h-6 border-blue-400 bg-white/90 px-2 py-0.5 shadow-sm focus-visible:border-blue-500 focus-visible:ring-1 focus-visible:ring-blue-400/50 focus-visible:ring-offset-0 dark:bg-gray-800/90"
          />
        ) : (
          <span
            className={`cursor-text truncate rounded px-1 ${isSelected ? "bg-primary/10" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              if (onItemNameClick) {
                onItemNameClick(entry, index, e);
              } else if (onNameClick) {
                onNameClick(e);
              } else if (onItemClick) {
                onItemClick(entry, index, e);
              } else {
                onClick?.(e);
              }
            }}
          >
            {entry.name}
          </span>
        )}
        {!isEditing && pairedBadge && (
          <span className="bg-primary/10 text-primary shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium">
            {pairedBadge}
          </span>
        )}
        {!isEditing && cullingState?.flag === "pick" && (
          <span
            className="inline-flex shrink-0 items-center rounded bg-emerald-500/15 px-1 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"
            title={t("file_list.culling.pick")}
          >
            <Check className="h-2.5 w-2.5" aria-hidden="true" />
          </span>
        )}
        {!isEditing && cullingState?.flag === "reject" && (
          <span
            className="bg-destructive/15 text-destructive inline-flex shrink-0 items-center rounded px-1 py-0.5 text-[10px] font-medium"
            title={t("file_list.culling.reject")}
          >
            <XCircle className="h-2.5 w-2.5" aria-hidden="true" />
          </span>
        )}
        {!isEditing && cullingState && cullingState.rating > 0 && (
          <span
            className="inline-flex shrink-0 items-center gap-0.5 text-[10px] font-medium text-amber-500 tabular-nums"
            title={`${cullingState.rating}★`}
          >
            <Star className="h-2.5 w-2.5 fill-amber-400 text-amber-400" aria-hidden="true" />
            {cullingState.rating}
          </span>
        )}
        {!isEditing && <FinderTagDots tags={entry.tags} />}
      </div>
      <div className="finder-list-sharpness shrink-0 px-2">
        {isPhoto && <SharpnessBadge verdict={visibleSharpness} />}
      </div>
      <div className="finder-list-exposure shrink-0 px-2">
        {isPhoto && <PhotoParameters summary={summary} compact />}
      </div>
      {columnVisibility?.kind && (
        <div
          style={{ width: `${columnWidths?.kind ?? 88}px` }}
          className="text-muted-foreground shrink-0 truncate px-2 text-right text-xs"
        >
          {entry.is_dir
            ? t("common.folder")
            : entry.package_type?.toUpperCase() ||
              entry.extension?.toUpperCase() ||
              t("common.file")}
        </div>
      )}
      <div
        style={{ width: `${columnWidths?.size ?? 96}px` }}
        className="text-muted-foreground shrink-0 px-2 text-right tabular-nums"
      >
        {entry.is_dir ? "--" : formatFileSize(entry.size)}
      </div>
      <div
        style={{ width: `${columnWidths?.date ?? 112}px` }}
        className="text-muted-foreground shrink-0 px-2 text-right tabular-nums"
      >
        {formatDate(entry.modified)}
      </div>
      {columnVisibility?.created && (
        <div
          style={{ width: `${columnWidths?.created ?? 112}px` }}
          className="text-muted-foreground shrink-0 px-2 text-right tabular-nums"
        >
          {formatDate(entry.created ?? null)}
        </div>
      )}
      <div className="w-5 shrink-0" />
    </div>
  );
});

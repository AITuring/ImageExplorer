import { memo } from "react";
import type { FileEntry } from "@/types/index";
import { FileThumbnail } from "@/components/FileThumbnail";
import { Input } from "@/components/ui/input";
import { formatFileSize, formatDate } from "@/utils/format";

interface FileListItemProps {
  entry: FileEntry;
  isSelected: boolean;
  isEditing: boolean;
  editValue: string;
  onEditValueChange: (value: string) => void;
  onSubmitRename: () => void;
  onCancelRename: () => void;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onMove?: (source: string, target: string) => void;
}

export const FileListItem = memo(function FileListItem({
  entry,
  isSelected,
  isEditing,
  editValue,
  onEditValueChange,
  onSubmitRename,
  onCancelRename,
  onClick,
  onDoubleClick,
}: FileListItemProps) {
  return (
    <div
      className={`flex w-full cursor-default items-center rounded-md p-2 text-sm transition-colors ${
        isSelected
          ? "bg-accent/90 ring-primary/30 ring-1"
          : "hover:bg-accent/60 focus:bg-accent/60"
      }`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <FileThumbnail
          entry={entry}
          size={24}
          className="h-6 w-6 shrink-0 rounded object-contain"
          fallbackClassName={
            entry.is_dir ? "h-5 w-5 text-blue-500" : "text-muted-foreground h-5 w-5"
          }
        />
        {isEditing ? (
          <Input
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
          <span className="truncate">{entry.name}</span>
        )}
      </div>
      <div className="text-muted-foreground w-24 shrink-0 px-2 text-right">
        {entry.is_dir ? "--" : formatFileSize(entry.size)}
      </div>
      <div className="text-muted-foreground w-28 shrink-0 px-2 text-right">
        {formatDate(entry.modified)}
      </div>
    </div>
  );
});

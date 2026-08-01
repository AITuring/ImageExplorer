import { memo } from "react";
import type { FileEntry } from "@/types/index";
import { FileThumbnail } from "@/components/FileThumbnail";
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
  onDoubleClick: () => void;
  onMove?: (source: string, target: string) => void;
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
  onDoubleClick,
}: FileGridItemProps) {
  return (
    <div
      className={`group flex cursor-default flex-col items-center rounded-lg p-3 transition-colors ${
        isSelected
          ? "bg-accent/90 ring-primary/40 shadow-sm ring-2"
          : "hover:bg-accent/60 hover:ring-border/60 ring-1 ring-transparent"
      }`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <div className="mb-2 flex h-20 w-20 items-center justify-center overflow-hidden">
        <FileThumbnail
          entry={entry}
          size={80}
          className="h-20 w-20 rounded-md object-contain"
          fallbackClassName={
            entry.is_dir ? "h-16 w-16 text-blue-500" : "text-muted-foreground h-16 w-16"
          }
        />
      </div>
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
          className="h-6 w-full border-blue-400 bg-white/90 px-1.5 py-0.5 text-center text-xs shadow-sm focus-visible:border-blue-500 focus-visible:ring-1 focus-visible:ring-blue-400/50 focus-visible:ring-offset-0 dark:bg-gray-800/90"
        />
      ) : (
        <div className="w-full text-center">
          <span className="line-clamp-2 text-xs font-medium break-all" title={entry.name}>
            {entry.name}
          </span>
        </div>
      )}
    </div>
  );
});

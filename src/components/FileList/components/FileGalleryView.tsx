import { memo, useRef, useCallback, useEffect, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { FileEntry } from "@/types/index";
import { FileThumbnail } from "@/components/FileThumbnail";
import { AppContextMenu } from "@/components/AppContextMenu";
import type { FileActions } from "@/types";
import { FILE_DRAG_MIME, readFileDragData, serializeFileDragData } from "@/lib/dragData";

/** 网格项尺寸 */
const ITEM_SIZE = 180;
const GAP = 12;
const ROW_HEIGHT = ITEM_SIZE + GAP;

interface FileGalleryViewProps {
  sortedEntries: FileEntry[];
  selectedPaths: string[];
  selectedFileEntries: FileEntry[];
  editingPath: string | null;
  editValue: string;
  fileActions: FileActions;
  onEditValueChange: (value: string) => void;
  onSubmitRename: () => void;
  onCancelRename: () => void;
  onClick: (entry: FileEntry, index: number, e: React.MouseEvent) => void;
  onDoubleClick: (entry: FileEntry) => void;
  handleMove: (src: string, dest: string) => void;
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
}

/** 单个 Gallery 项 */
const GalleryItem = memo(function GalleryItem({
  entry,
  isSelected,
  onClick,
  onDoubleClick,
}: {
  entry: FileEntry;
  isSelected: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
}) {
  return (
    <div
      className={`group flex cursor-default flex-col items-center overflow-hidden rounded-lg transition-colors ${
        isSelected ? "bg-accent/80 ring-primary/20 ring-1" : "hover:bg-accent/50"
      }`}
      style={{ width: ITEM_SIZE, height: ITEM_SIZE }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {/* 缩略图区域 */}
      <div className="flex h-[130px] w-full items-center justify-center overflow-hidden rounded-t-lg bg-black/5 dark:bg-white/5">
        <FileThumbnail
          entry={entry}
          size={130}
          className="max-h-full max-w-full rounded-md object-contain"
          fallbackClassName={
            entry.is_dir ? "h-12 w-12 text-blue-500" : "text-muted-foreground h-12 w-12"
          }
        />
      </div>
      {/* 文件名 */}
      <div className="flex w-full flex-1 items-center justify-center px-2">
        <span
          className="line-clamp-2 w-full text-center text-xs font-medium break-all"
          title={entry.name}
        >
          {entry.name}
        </span>
      </div>
    </div>
  );
});

export function FileGalleryView({
  sortedEntries,
  selectedPaths,
  selectedFileEntries,
  fileActions,
  onClick,
  onDoubleClick,
  handleMove,
  scrollContainerRef,
}: FileGalleryViewProps) {
  const internalScrollRef = useRef<HTMLDivElement>(null);
  const scrollRef = scrollContainerRef ?? internalScrollRef;
  const columnsRef = useRef(4);

  const updateColumns = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    columnsRef.current = Math.max(1, Math.floor(el.clientWidth / (ITEM_SIZE + GAP)));
  }, []);

  useEffect(() => {
    updateColumns();
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(updateColumns);
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateColumns]);

  const rowCount = Math.ceil(sortedEntries.length / columnsRef.current);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 3,
  });

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto p-2">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const cols = columnsRef.current;
          const startIdx = virtualRow.index * cols;
          const rowEntries = sortedEntries.slice(startIdx, startIdx + cols);
          return (
            <div
              key={virtualRow.index}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <div className="flex justify-center gap-3">
                {rowEntries.map((entry, colIdx) => {
                  const globalIndex = startIdx + colIdx;
                  return (
                    <div
                      key={entry.path}
                      draggable
                      onDragStart={(e) => {
                        const serialized = serializeFileDragData([entry.path]);
                        e.dataTransfer.setData(FILE_DRAG_MIME, serialized);
                        e.dataTransfer.setData("application/json", serialized);
                        e.dataTransfer.setData("text/plain", serialized);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onDragOver={(e) => {
                        if (!entry.is_dir) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                      }}
                      onDrop={(e) => {
                        if (!entry.is_dir) return;
                        e.preventDefault();
                        try {
                          const data = readFileDragData(e.dataTransfer);
                          if (data) {
                            data.paths
                              .filter((path) => path !== entry.path)
                              .forEach((path) => handleMove(path, entry.path));
                          }
                        } catch {
                          // ignore invalid drag data
                        }
                      }}
                    >
                      <AppContextMenu
                        type={entry.is_dir ? "folder" : "file"}
                        entry={entry}
                        selectedEntries={selectedFileEntries}
                        fileActions={fileActions}
                      >
                        <GalleryItem
                          entry={entry}
                          isSelected={selectedPaths.includes(entry.path)}
                          onClick={(e) => onClick(entry, globalIndex, e)}
                          onDoubleClick={() => onDoubleClick(entry)}
                        />
                      </AppContextMenu>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

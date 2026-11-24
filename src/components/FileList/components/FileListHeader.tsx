import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronUp, ChevronDown, SlidersHorizontal, Check } from "lucide-react";
import { SortField, SortDirection } from "../hooks/useFileSort";
import { useViewMode, type GroupByField, type ListColumnWidths } from "@/stores/viewMode";

interface FileListHeaderProps {
  sortField: SortField;
  sortDirection: SortDirection;
  onSort: (field: SortField) => void;
}

function ResizeHandle({
  column,
  currentWidth,
  onResize,
}: {
  column: keyof ListColumnWidths;
  currentWidth: number;
  onResize: (column: keyof ListColumnWidths, width: number) => void;
}) {
  const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = currentWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      // Dragging left widens the right-aligned trailing column; dragging right narrows it.
      const delta = startX - moveEvent.clientX;
      onResize(column, startWidth + delta);
    };
    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onMouseDown={handleMouseDown}
      className="hover:bg-primary/50 bg-border/40 mx-0.5 h-3.5 w-[2px] shrink-0 cursor-col-resize rounded-full transition-colors"
    />
  );
}

export function FileListHeader({ sortField, sortDirection, onSort }: FileListHeaderProps) {
  const { t } = useTranslation();
  const {
    groupBy,
    setGroupBy,
    listColumnWidths,
    listColumnVisibility,
    setListColumnWidth,
    toggleListColumn,
  } = useViewMode();
  const [menuOpen, setMenuOpen] = useState(false);

  const SortIcon = sortDirection === "asc" ? ChevronUp : ChevronDown;

  return (
    <div className="finder-list-header border-border/50 text-muted-foreground relative mb-2 flex items-center border-b pb-2 text-xs font-medium select-none">
      <div
        className="hover:text-foreground flex min-w-0 flex-1 cursor-pointer items-center gap-1 px-2 transition-colors"
        onClick={() => onSort("name")}
      >
        {t("file_list.col_name")}
        {sortField === "name" && <SortIcon className="h-3 w-3" />}
      </div>

      <div className="finder-list-sharpness shrink-0 px-2">{t("file_list.col_sharpness")}</div>
      <div className="finder-list-exposure shrink-0 px-2">{t("file_list.col_exposure")}</div>

      {listColumnVisibility.kind && (
        <>
          <ResizeHandle
            column="kind"
            currentWidth={listColumnWidths.kind}
            onResize={setListColumnWidth}
          />
          <div
            style={{ width: `${listColumnWidths.kind}px` }}
            className="hover:text-foreground flex shrink-0 cursor-pointer items-center justify-end gap-1 px-2 text-right transition-colors"
            onClick={() => onSort("kind")}
          >
            <span className="truncate">{t("file_list.col_kind")}</span>
            {sortField === "kind" && <SortIcon className="h-3 w-3 shrink-0" />}
          </div>
        </>
      )}

      <ResizeHandle
        column="size"
        currentWidth={listColumnWidths.size}
        onResize={setListColumnWidth}
      />
      <div
        style={{ width: `${listColumnWidths.size}px` }}
        className="hover:text-foreground flex shrink-0 cursor-pointer items-center justify-end gap-1 px-2 text-right transition-colors"
        onClick={() => onSort("size")}
      >
        <span className="truncate">{t("file_list.col_size")}</span>
        {sortField === "size" && <SortIcon className="h-3 w-3 shrink-0" />}
      </div>

      <ResizeHandle
        column="date"
        currentWidth={listColumnWidths.date}
        onResize={setListColumnWidth}
      />
      <div
        style={{ width: `${listColumnWidths.date}px` }}
        className="hover:text-foreground flex shrink-0 cursor-pointer items-center justify-end gap-1 px-2 text-right transition-colors"
        onClick={() => onSort("date")}
      >
        <span className="truncate">{t("file_list.col_date")}</span>
        {sortField === "date" && <SortIcon className="h-3 w-3 shrink-0" />}
      </div>

      {listColumnVisibility.created && (
        <>
          <ResizeHandle
            column="created"
            currentWidth={listColumnWidths.created}
            onResize={setListColumnWidth}
          />
          <div
            style={{ width: `${listColumnWidths.created}px` }}
            className="hover:text-foreground flex shrink-0 cursor-pointer items-center justify-end gap-1 px-2 text-right transition-colors"
            onClick={() => onSort("created")}
          >
            <span className="truncate">{t("file_list.col_created")}</span>
            {sortField === "created" && <SortIcon className="h-3 w-3 shrink-0" />}
          </div>
        </>
      )}

      <div className="relative ml-0.5 shrink-0">
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          onBlur={() => window.setTimeout(() => setMenuOpen(false), 150)}
          title={t("file_list.col_toggle")}
          aria-label={t("file_list.col_toggle")}
          aria-expanded={menuOpen}
          className="hover:bg-accent hover:text-foreground rounded p-1 transition-colors"
        >
          <SlidersHorizontal className="h-3 w-3" />
        </button>
        {menuOpen && (
          <div className="finder-popover bg-popover text-popover-foreground absolute top-full right-0 z-50 mt-1 w-36 rounded-md border p-1 shadow-lg">
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => toggleListColumn("kind")}
              className="hover:bg-accent flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs"
            >
              <span className="flex h-3.5 w-3.5 items-center justify-center">
                {listColumnVisibility.kind && <Check className="h-3 w-3" />}
              </span>
              <span>{t("file_list.col_kind")}</span>
            </button>
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => toggleListColumn("created")}
              className="hover:bg-accent flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs"
            >
              <span className="flex h-3.5 w-3.5 items-center justify-center">
                {listColumnVisibility.created && <Check className="h-3 w-3" />}
              </span>
              <span>{t("file_list.col_created")}</span>
            </button>
            <div className="border-border/60 my-1 border-t" />
            <div className="text-muted-foreground px-2 py-0.5 text-[10px] font-medium">
              {t("file_list.group.label")}
            </div>
            {(
              [
                ["none", "file_list.group.none"],
                ["kind", "file_list.group.kind"],
                ["date", "file_list.group.date"],
                ["size", "file_list.group.size"],
                ["tag", "file_list.group.tag"],
              ] as Array<[GroupByField, string]>
            ).map(([field, labelKey]) => (
              <button
                key={field}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setGroupBy(field);
                  setMenuOpen(false);
                }}
                className="hover:bg-accent flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs"
              >
                <span className="flex h-3.5 w-3.5 items-center justify-center">
                  {groupBy === field && <Check className="h-3 w-3" />}
                </span>
                <span>{t(labelKey)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

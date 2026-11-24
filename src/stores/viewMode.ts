import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ViewMode = "icon" | "list" | "column" | "gallery";

export interface ListColumnWidths {
  kind: number;
  size: number;
  date: number;
  created: number;
}

export interface ListColumnVisibility {
  kind: boolean;
  created: boolean;
}

export const ICON_SIZE_MIN = 108;
export const ICON_SIZE_MAX = 240;
export const ICON_SIZE_DEFAULT = 160;

export const COLUMN_VIEW_WIDTH_MIN = 160;
export const COLUMN_VIEW_WIDTH_MAX = 480;
export const COLUMN_VIEW_WIDTH_DEFAULT = 240;

export const DEFAULT_LIST_COLUMN_WIDTHS: ListColumnWidths = {
  kind: 88,
  size: 96,
  date: 112,
  created: 112,
};

export const DEFAULT_LIST_COLUMN_VISIBILITY: ListColumnVisibility = {
  kind: false,
  created: false,
};

interface ViewModeState {
  viewMode: ViewMode;
  iconSize: number;
  columnViewWidth: number;
  cullAutoAdvance: boolean;
  listColumnWidths: ListColumnWidths;
  listColumnVisibility: ListColumnVisibility;
  setViewMode: (mode: ViewMode) => void;
  setIconSize: (size: number) => void;
  setColumnViewWidth: (width: number) => void;
  toggleCullAutoAdvance: () => void;
  setListColumnWidth: (column: keyof ListColumnWidths, width: number) => void;
  toggleListColumn: (column: keyof ListColumnVisibility) => void;
}

function clampIconSize(size: number): number {
  if (!Number.isFinite(size)) return ICON_SIZE_DEFAULT;
  return Math.max(ICON_SIZE_MIN, Math.min(ICON_SIZE_MAX, Math.round(size)));
}

function clampColumnViewWidth(width: number): number {
  if (!Number.isFinite(width)) return COLUMN_VIEW_WIDTH_DEFAULT;
  return Math.max(COLUMN_VIEW_WIDTH_MIN, Math.min(COLUMN_VIEW_WIDTH_MAX, Math.round(width)));
}

function clampColumnWidth(width: number): number {
  if (!Number.isFinite(width)) return 96;
  return Math.max(64, Math.min(280, Math.round(width)));
}

export const useViewMode = create<ViewModeState>()(
  persist(
    (set) => ({
      viewMode: "list",
      iconSize: ICON_SIZE_DEFAULT,
      columnViewWidth: COLUMN_VIEW_WIDTH_DEFAULT,
      cullAutoAdvance: false,
      listColumnWidths: DEFAULT_LIST_COLUMN_WIDTHS,
      listColumnVisibility: DEFAULT_LIST_COLUMN_VISIBILITY,
      setViewMode: (mode) => set({ viewMode: mode }),
      setIconSize: (size) => set({ iconSize: clampIconSize(size) }),
      setColumnViewWidth: (width) => set({ columnViewWidth: clampColumnViewWidth(width) }),
      toggleCullAutoAdvance: () => set((state) => ({ cullAutoAdvance: !state.cullAutoAdvance })),
      setListColumnWidth: (column, width) =>
        set((state) => ({
          listColumnWidths: {
            ...state.listColumnWidths,
            [column]: clampColumnWidth(width),
          },
        })),
      toggleListColumn: (column) =>
        set((state) => ({
          listColumnVisibility: {
            ...state.listColumnVisibility,
            [column]: !state.listColumnVisibility[column],
          },
        })),
    }),
    {
      name: "view-mode-storage",
      merge: (persisted, current) => {
        const saved = persisted as Partial<ViewModeState> | undefined;
        const mode = saved?.viewMode;
        return {
          ...current,
          viewMode:
            mode === "gallery" || mode === "icon" || mode === "column" || mode === "list"
              ? mode
              : current.viewMode,
          iconSize:
            typeof saved?.iconSize === "number" ? clampIconSize(saved.iconSize) : current.iconSize,
          columnViewWidth:
            typeof saved?.columnViewWidth === "number"
              ? clampColumnViewWidth(saved.columnViewWidth)
              : current.columnViewWidth,
          cullAutoAdvance:
            typeof saved?.cullAutoAdvance === "boolean"
              ? saved.cullAutoAdvance
              : current.cullAutoAdvance,
          listColumnWidths: {
            ...DEFAULT_LIST_COLUMN_WIDTHS,
            ...(saved?.listColumnWidths ?? {}),
          },
          listColumnVisibility: {
            ...DEFAULT_LIST_COLUMN_VISIBILITY,
            ...(saved?.listColumnVisibility ?? {}),
          },
        };
      },
    }
  )
);

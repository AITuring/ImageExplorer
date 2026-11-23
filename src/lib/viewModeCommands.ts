import { useViewMode, type ViewMode } from "@/stores/viewMode";
import type { AppCommand } from "@/lib/commands";

export const viewModeCommands: Record<ViewMode, AppCommand<void>> = {
  icon: {
    id: "view.icon",
    shortcut: "⌘1",
    enabled: () => useViewMode.getState().viewMode !== "icon",
    run: () => useViewMode.getState().setViewMode("icon"),
  },
  list: {
    id: "view.list",
    shortcut: "⌘2",
    enabled: () => useViewMode.getState().viewMode !== "list",
    run: () => useViewMode.getState().setViewMode("list"),
  },
  column: {
    id: "view.column",
    shortcut: "⌘3",
    enabled: () => useViewMode.getState().viewMode !== "column",
    run: () => useViewMode.getState().setViewMode("column"),
  },
  gallery: {
    id: "view.gallery",
    shortcut: "⌘4",
    enabled: () => useViewMode.getState().viewMode !== "gallery",
    run: () => useViewMode.getState().setViewMode("gallery"),
  },
};

import { useCallback, useEffect, useReducer, useState } from "react";
import type { FileEntry } from "@/types";
import { initialSelection, selectionReducer } from "./selectionModel";

export function useFileSelection(entries: FileEntry[] = []) {
  const [selection, dispatch] = useReducer(selectionReducer, initialSelection);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  useEffect(() => {
    dispatch({ type: "prune", paths: entries.map((entry) => entry.path) });
  }, [entries]);

  const selectSingle = useCallback((path: string, _index: number) => {
    dispatch({ type: "single", path });
  }, []);

  const toggleSelection = useCallback((path: string, _index: number) => {
    dispatch({ type: "toggle", path });
  }, []);

  const selectRange = useCallback((rangeEntries: FileEntry[], toIndex: number) => {
    dispatch({ type: "range", entries: rangeEntries, toIndex });
  }, []);

  const selectAll = useCallback((allEntries: FileEntry[]) => {
    dispatch({ type: "all", entries: allEntries });
  }, []);

  const clearSelection = useCallback(() => dispatch({ type: "clear" }), []);
  const setSelectedPath = useCallback((path: string | null) => {
    dispatch({ type: "set", path });
  }, []);

  const selectedPath = selection.focusedPath && selection.selectedPaths.includes(selection.focusedPath)
    ? selection.focusedPath
    : (selection.selectedPaths[0] ?? null);

  const handleStartRename = useCallback((entry: FileEntry) => {
    if (entry.readonly) return;
    setEditingPath(entry.path);
    setEditValue(entry.name);
  }, []);

  const handleCancelRename = useCallback(() => {
    setEditingPath(null);
    setEditValue("");
  }, []);

  return {
    selectedPaths: selection.selectedPaths,
    selectedPath,
    focusedPath: selectedPath,
    anchorPath: selection.anchorPath,
    setSelectedPath,
    selectSingle,
    toggleSelection,
    selectRange,
    selectAll,
    clearSelection,
    editingPath,
    setEditingPath,
    editValue,
    setEditValue,
    handleStartRename,
    handleCancelRename,
  };
}

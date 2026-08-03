import { useState, useMemo, useDeferredValue } from "react";
import { FileEntry } from "@/types";
import type { SortDirection, SortField } from "@/types";

export function useFileSort(entries: FileEntry[]) {
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const deferredEntries = useDeferredValue(entries);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  };

  const handleArrange = (field = sortField) => {
    setSortField(field);
    setSortDirection("asc");
  };

  const sortedEntries = useMemo(() => {
    return [...deferredEntries].sort((a, b) => {
      // 始终让文件夹排在前面
      if (a.is_dir !== b.is_dir) {
        return a.is_dir ? -1 : 1;
      }

      let comparison = 0;
      switch (sortField) {
        case "name":
          comparison = a.name.localeCompare(b.name);
          break;
        case "size":
          comparison = (a.size || 0) - (b.size || 0);
          break;
        case "date":
          comparison = (a.modified || 0) - (b.modified || 0);
          break;
        case "created":
          comparison = (a.created || 0) - (b.created || 0);
          break;
        case "kind":
          comparison = getEntryKind(a).localeCompare(getEntryKind(b));
          break;
      }

      return sortDirection === "asc" ? comparison : -comparison;
    });
  }, [deferredEntries, sortField, sortDirection]);

  return {
    sortField,
    sortDirection,
    handleSort,
    handleArrange,
    sortedEntries,
  };
}

function getEntryKind(entry: FileEntry) {
  if (entry.is_dir) return "folder";
  if (entry.is_package && entry.package_type) return entry.package_type;
  return entry.extension || "file";
}

export type { SortField, SortDirection };

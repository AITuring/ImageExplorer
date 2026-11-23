import { startTransition, useCallback, useDeferredValue, useMemo, useState } from "react";
import { FileEntry } from "@/types";
import type { SortDirection, SortField } from "@/types";

const FILE_NAME_COLLATOR = new Intl.Collator();

export function useFileSort(entries: FileEntry[]) {
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const deferredEntries = useDeferredValue(entries);

  const handleSort = useCallback(
    (field: SortField) => {
      startTransition(() => {
        if (sortField === field) {
          setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
        } else {
          setSortField(field);
          setSortDirection("asc");
        }
      });
    },
    [sortField]
  );

  const handleArrange = useCallback(
    (field = sortField) => {
      startTransition(() => {
        setSortField(field);
        setSortDirection("asc");
      });
    },
    [sortField]
  );

  const sortedEntries = useMemo(() => {
    if (deferredEntries.length <= 1) return deferredEntries;
    const direction = sortDirection === "asc" ? 1 : -1;
    const next = deferredEntries.slice();

    // Array.prototype.sort is guaranteed stable in modern JS engines, so we can
    // sort a shallow copy directly without allocating N wrapper objects + a
    // second output array on 100k-entry directories.
    if (sortField === "name") {
      next.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return FILE_NAME_COLLATOR.compare(a.name, b.name) * direction;
      });
    } else if (sortField === "kind") {
      next.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return FILE_NAME_COLLATOR.compare(getEntryKind(a), getEntryKind(b)) * direction;
      });
    } else if (sortField === "size") {
      next.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return ((a.size || 0) - (b.size || 0)) * direction;
      });
    } else if (sortField === "date") {
      next.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return ((a.modified || 0) - (b.modified || 0)) * direction;
      });
    } else {
      next.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return ((a.created || 0) - (b.created || 0)) * direction;
      });
    }

    return next;
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

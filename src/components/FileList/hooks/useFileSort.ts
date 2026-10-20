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
    const sortableEntries = deferredEntries.map((entry, originalIndex) => ({
      entry,
      originalIndex,
      textValue:
        sortField === "name" ? entry.name : sortField === "kind" ? getEntryKind(entry) : "",
      numericValue:
        sortField === "size"
          ? entry.size || 0
          : sortField === "date"
            ? entry.modified || 0
            : sortField === "created"
              ? entry.created || 0
              : 0,
    }));

    sortableEntries.sort((first, second) => {
      const a = first.entry;
      const b = second.entry;
      // 始终让文件夹排在前面
      if (a.is_dir !== b.is_dir) {
        return a.is_dir ? -1 : 1;
      }

      const comparison =
        sortField === "name" || sortField === "kind"
          ? FILE_NAME_COLLATOR.compare(first.textValue, second.textValue)
          : first.numericValue - second.numericValue;

      if (comparison === 0) return first.originalIndex - second.originalIndex;
      return sortDirection === "asc" ? comparison : -comparison;
    });

    return sortableEntries.map(({ entry }) => entry);
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

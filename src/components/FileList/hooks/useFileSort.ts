import { startTransition, useCallback, useMemo, useState } from "react";
import { FileEntry } from "@/types";
import type { SortDirection, SortField } from "@/types";
import { compareFileNames, sortFileEntries } from "./finderListModel";

export { compareFileNames, sortFileEntries };

export function useFileSort(
  entries: FileEntry[],
  capturedLookup?: (entry: FileEntry) => string | null | undefined,
  capturedVersion = 0
) {
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

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

  const effectiveCapturedVersion = sortField === "captured" ? capturedVersion : 0;
  const sortedEntries = useMemo(() => {
    void effectiveCapturedVersion;
    return sortFileEntries(entries, sortField, sortDirection, capturedLookup);
  }, [capturedLookup, effectiveCapturedVersion, entries, sortField, sortDirection]);

  return {
    sortField,
    sortDirection,
    handleSort,
    handleArrange,
    sortedEntries,
  };
}

export type { SortField, SortDirection };

import { startTransition, useCallback, useDeferredValue, useMemo, useState } from "react";
import { FileEntry } from "@/types";
import type { SortDirection, SortField } from "@/types";
import { compareFileNames, sortFileEntries } from "./finderListModel";

export { compareFileNames, sortFileEntries };

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

  const sortedEntries = useMemo(
    () => sortFileEntries(deferredEntries, sortField, sortDirection),
    [deferredEntries, sortField, sortDirection]
  );

  return {
    sortField,
    sortDirection,
    handleSort,
    handleArrange,
    sortedEntries,
  };
}

export type { SortField, SortDirection };

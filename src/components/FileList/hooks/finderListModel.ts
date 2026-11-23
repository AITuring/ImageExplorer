import type { FileEntry, SortDirection, SortField } from "@/types";

// Match macOS Finder natural sorting: IMG_2.jpg sorts before IMG_10.jpg, case-insensitive.
const FILE_NAME_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function compareFileNames(left: string, right: string): number {
  return FILE_NAME_COLLATOR.compare(left, right);
}

function getEntryKind(
  entry: Pick<FileEntry, "is_dir" | "is_package" | "package_type" | "extension">
) {
  if (entry.is_dir) return "folder";
  if (entry.is_package && entry.package_type) return entry.package_type;
  return entry.extension || "file";
}

export function sortFileEntries<
  T extends Pick<
    FileEntry,
    | "name"
    | "is_dir"
    | "size"
    | "modified"
    | "created"
    | "extension"
    | "is_package"
    | "package_type"
  >,
>(entries: T[], sortField: SortField = "name", sortDirection: SortDirection = "asc"): T[] {
  if (entries.length <= 1) return entries;
  const direction = sortDirection === "asc" ? 1 : -1;
  if (sortField === "name") {
    // Fast O(N) pre-check: Rust `get_entries` already delivers directories in
    // Finder natural order, so default name/asc skips allocating & re-sorting.
    let alreadySorted = true;
    for (let index = 1; index < entries.length; index += 1) {
      const prev = entries[index - 1];
      const curr = entries[index];
      const order =
        prev.is_dir !== curr.is_dir
          ? prev.is_dir
            ? -1
            : 1
          : FILE_NAME_COLLATOR.compare(prev.name, curr.name) * direction;
      if (order > 0) {
        alreadySorted = false;
        break;
      }
    }
    if (alreadySorted) return entries;

    const next = entries.slice();
    next.sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return FILE_NAME_COLLATOR.compare(a.name, b.name) * direction;
    });
    return next;
  }

  const next = entries.slice();
  if (sortField === "kind") {
    next.sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      const kindCmp = FILE_NAME_COLLATOR.compare(getEntryKind(a), getEntryKind(b)) * direction;
      return kindCmp !== 0 ? kindCmp : FILE_NAME_COLLATOR.compare(a.name, b.name);
    });
  } else if (sortField === "size") {
    next.sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      const sizeCmp = ((a.size || 0) - (b.size || 0)) * direction;
      return sizeCmp !== 0 ? sizeCmp : FILE_NAME_COLLATOR.compare(a.name, b.name);
    });
  } else if (sortField === "date") {
    next.sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      const dateCmp = ((a.modified || 0) - (b.modified || 0)) * direction;
      return dateCmp !== 0 ? dateCmp : FILE_NAME_COLLATOR.compare(a.name, b.name);
    });
  } else {
    next.sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      const createdCmp = ((a.created || 0) - (b.created || 0)) * direction;
      return createdCmp !== 0 ? createdCmp : FILE_NAME_COLLATOR.compare(a.name, b.name);
    });
  }

  return next;
}

/**
 * Finder-style type-ahead matcher:
 * - Matches the first entry whose name starts with `query` (case-insensitive).
 * - When the user taps the same single letter repeatedly (e.g. "a", "a"),
 *   cycles to the next matching entry after `currentIndex`.
 */
export function findTypeAheadMatch(
  entries: ReadonlyArray<Pick<FileEntry, "name">>,
  query: string,
  currentIndex: number,
  repeatSingleChar = false
): number {
  const normalized = query.toLocaleLowerCase();
  if (!normalized || entries.length === 0) return -1;

  if (repeatSingleChar && currentIndex >= 0) {
    for (let offset = 1; offset <= entries.length; offset += 1) {
      const candidateIndex = (currentIndex + offset) % entries.length;
      if (entries[candidateIndex].name.toLocaleLowerCase().startsWith(normalized)) {
        return candidateIndex;
      }
    }
    return -1;
  }

  return entries.findIndex((entry) => entry.name.toLocaleLowerCase().startsWith(normalized));
}

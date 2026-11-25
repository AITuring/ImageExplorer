/**
 * Pure file drag-and-drop path/volume helpers shared by FileList, Sidebar,
 * ColumnView, and unit tests.
 */

export function normalizeDirectoryPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : "/";
}

/**
 * Return the logical macOS volume root for a path so cross-volume drags
 * (e.g. `/Volumes/DriveA/...` -> `/Volumes/DriveB/...` or boot disk -> USB)
 * follow native macOS Finder copy-by-default semantics.
 */
export function getPathVolumeRoot(path: string): string {
  const normalized = normalizeDirectoryPath(path);
  const volumesPrefix = "/Volumes/";
  if (normalized.startsWith(volumesPrefix)) {
    const rest = normalized.slice(volumesPrefix.length);
    const slashIdx = rest.indexOf("/");
    const volumeName = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
    if (volumeName.length > 0) {
      return `${volumesPrefix}${volumeName}`;
    }
  }
  return "/";
}

/**
 * Resolve whether dropping `sourcePaths` into `destDir` should copy or move:
 * - Holding Option/Alt always copies.
 * - Within the same volume: defaults to move.
 * - Across different volumes: defaults to copy (hold Command to move),
 *   matching native macOS Finder behavior.
 */
export function resolveFileDropOperation(
  sourcePaths: readonly string[],
  destDir: string,
  modifiers: { altKey: boolean; metaKey: boolean }
): "copy" | "move" {
  if (modifiers.altKey) return "copy";
  const destVolume = getPathVolumeRoot(destDir);
  const isCrossVolume = sourcePaths.some((source) => getPathVolumeRoot(source) !== destVolume);
  if (isCrossVolume) {
    return modifiers.metaKey ? "move" : "copy";
  }
  return "move";
}

/**
 * Filter out invalid drop targets (dropping a folder onto itself, dropping an
 * ancestor into its own descendant, or dropping an item into its own parent
 * directory when moving).
 */
export function filterDropPathsForTarget(
  sourcePaths: readonly string[],
  destDir: string,
  operation: "copy" | "move"
): string[] {
  const normalizedDest = normalizeDirectoryPath(destDir);
  return sourcePaths.filter((sourcePath) => {
    const normalizedSource = normalizeDirectoryPath(sourcePath);
    if (normalizedSource === normalizedDest) return false;
    if (normalizedDest.startsWith(`${normalizedSource}/`)) return false;
    if (operation === "move") {
      const lastSlash = normalizedSource.lastIndexOf("/");
      const parentDir = lastSlash <= 0 ? "/" : normalizedSource.slice(0, lastSlash);
      if (parentDir === normalizedDest) return false;
    }
    return true;
  });
}

function normalizedBasename(path: string): string {
  const normalized = normalizeDirectoryPath(path);
  const lastSlash = normalized.lastIndexOf("/");
  const base = lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
  return base.normalize("NFC");
}

/**
 * Verify native drag pasteboard paths against the filenames WebKit exposed in
 * `dataTransfer.files` so a stale system drag pasteboard from an unrelated drag
 * is never accidentally applied.
 */
export function matchPasteboardPathsToExpectedNames(
  pasteboardPaths: readonly string[],
  expectedFileNames: readonly string[]
): string[] {
  if (pasteboardPaths.length === 0) return [];
  if (expectedFileNames.length === 0) {
    return [...pasteboardPaths];
  }
  const expectedSet = new Set(expectedFileNames.map((name) => name.normalize("NFC")));
  const matched = pasteboardPaths.filter((path) => expectedSet.has(normalizedBasename(path)));
  return matched;
}

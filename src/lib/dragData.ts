import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  filterDropPathsForTarget,
  matchPasteboardPathsToExpectedNames,
  resolveFileDropOperation,
} from "@/lib/dragDropUtils";

export {
  filterDropPathsForTarget,
  getPathVolumeRoot,
  matchPasteboardPathsToExpectedNames,
  normalizeDirectoryPath,
  resolveFileDropOperation,
} from "@/lib/dragDropUtils";

export const FILE_DRAG_MIME = "application/x-imageexplorer-file";

export interface FileDragData {
  kind: "file";
  paths: string[];
}

interface ActiveNativeFileDrag {
  sessionId: string;
  paths: string[];
}

interface NativeFileDragStarted {
  sessionId: string;
  paths: string[];
}

interface NativeFileDragEnded {
  sessionId: string;
}

const NATIVE_FILE_DRAG_STARTED_EVENT = "native-file-drag-started";
const NATIVE_FILE_DRAG_ENDED_EVENT = "native-file-drag-ended";
const ACTIVE_DRAG_EXPIRY_MS = 60_000;
const DRAG_END_GRACE_PERIOD_MS = 1_000;

let activeNativeFileDrag: ActiveNativeFileDrag | null = null;
let activeDragExpiry: ReturnType<typeof setTimeout> | null = null;

function uniquePaths(paths: string[]) {
  return [...new Set(paths.filter((path) => path.length > 0))];
}

function createDragSessionId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function clearActiveNativeFileDrag(sessionId?: string) {
  if (sessionId && activeNativeFileDrag?.sessionId !== sessionId) return;
  activeNativeFileDrag = null;
  if (activeDragExpiry) {
    clearTimeout(activeDragExpiry);
    activeDragExpiry = null;
  }
}

function setActiveNativeFileDrag(sessionId: string, paths: string[]) {
  clearActiveNativeFileDrag();
  activeNativeFileDrag = { sessionId, paths };
  activeDragExpiry = setTimeout(() => {
    clearActiveNativeFileDrag(sessionId);
  }, ACTIVE_DRAG_EXPIRY_MS);
}

// Keep every ImageExplorer window synchronized with any active native drag
// session so split-screen Window A -> Window B drops resolve immediately.
void listen<NativeFileDragStarted>(NATIVE_FILE_DRAG_STARTED_EVENT, ({ payload }) => {
  const paths = uniquePaths(payload.paths ?? []);
  if (payload.sessionId && paths.length > 0) {
    setActiveNativeFileDrag(payload.sessionId, paths);
  }
}).catch((error) => {
  console.error("Failed to listen for native file drag start", error);
});

void listen<NativeFileDragEnded>(NATIVE_FILE_DRAG_ENDED_EVENT, ({ payload }) => {
  // AppKit finishes the destination's drop callback before notifying the
  // source. Keep a short guard for the WebView event bridge so cross-window
  // drops can still recover the source paths.
  setTimeout(() => {
    clearActiveNativeFileDrag(payload.sessionId);
  }, DRAG_END_GRACE_PERIOD_MS);
}).catch((error) => {
  console.error("Failed to listen for native file drag completion", error);
});

/** Return the rendered thumbnail for the native drag image when it is ready. */
export function getFileDragIcon(container: Element) {
  return (
    container.querySelector<HTMLImageElement>('img[src^="data:image/png;base64,"]')?.src ?? null
  );
}

export async function startNativeFileDrag(paths: string[], icon: string | null) {
  const normalizedPaths = uniquePaths(paths);
  if (normalizedPaths.length === 0) {
    throw new Error("No files were provided for dragging");
  }

  const sessionId = createDragSessionId();
  setActiveNativeFileDrag(sessionId, normalizedPaths);

  try {
    await invoke("start_native_file_drag", {
      paths: normalizedPaths,
      icon,
      sessionId,
    });
  } catch (error) {
    clearActiveNativeFileDrag(sessionId);
    throw error;
  }
}

function parseSerializedFileDragData(raw: string): FileDragData | null {
  try {
    const data = JSON.parse(raw) as Partial<FileDragData>;
    if (data.kind !== "file" || !Array.isArray(data.paths) || data.paths.length === 0) {
      return null;
    }

    const paths = data.paths.filter((path): path is string => typeof path === "string");
    return paths.length > 0 ? { kind: "file", paths } : null;
  } catch {
    return null;
  }
}

function parsePlainPathList(raw: string): string[] {
  const paths: string[] = [];

  for (const value of raw.split(/\r?\n/)) {
    const candidate = value.trim();
    if (!candidate || candidate.startsWith("#")) continue;

    if (candidate.startsWith("file://")) {
      try {
        const url = new URL(candidate);
        let path = decodeURIComponent(url.pathname);
        if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
        paths.push(path);
      } catch {
        return [];
      }
      continue;
    }

    if (candidate.startsWith("/") || /^[A-Za-z]:[\\/]/.test(candidate)) {
      paths.push(candidate);
      continue;
    }

    return [];
  }

  return uniquePaths(paths);
}

/** Return true when a `dragover` event carries OS files or an internal file drag. */
export function hasFileDragPayload(dataTransfer: DataTransfer): boolean {
  if (activeNativeFileDrag) return true;
  const types = Array.from(dataTransfer.types ?? []);
  return (
    types.includes(FILE_DRAG_MIME) || types.includes("Files") || types.includes("text/uri-list")
  );
}

/** Compute the expected dropEffect cursor (`copy` vs `move`) during `dragover`. */
export function resolveFileDropEffect(
  dataTransfer: DataTransfer,
  destDir: string,
  modifiers: { altKey: boolean; metaKey: boolean }
): "copy" | "move" {
  if (activeNativeFileDrag && activeNativeFileDrag.paths.length > 0) {
    return resolveFileDropOperation(activeNativeFileDrag.paths, destDir, modifiers);
  }
  if (modifiers.altKey) return "copy";
  if (dataTransfer.effectAllowed === "copy") return "copy";
  return "move";
}

export function readFileDragData(dataTransfer: DataTransfer): FileDragData | null {
  const serializedPayloads = [
    dataTransfer.getData(FILE_DRAG_MIME),
    dataTransfer.getData("application/json"),
  ];
  for (const raw of serializedPayloads) {
    if (!raw) continue;
    const data = parseSerializedFileDragData(raw);
    if (data) return data;
  }

  const paths = parsePlainPathList(
    dataTransfer.getData("text/uri-list") || dataTransfer.getData("text/plain")
  );
  if (paths.length > 0) return { kind: "file", paths };

  if (activeNativeFileDrag) {
    const activePaths = activeNativeFileDrag.paths;
    clearActiveNativeFileDrag(activeNativeFileDrag.sessionId);
    return { kind: "file", paths: activePaths };
  }

  return null;
}

/**
 * Resolve dropped file paths synchronously when available (same-window or
 * cross-window ImageExplorer drag), or asynchronously from macOS's native
 * `NSPasteboardNameDrag` when files/folders are dragged in from Finder or
 * another desktop application.
 *
 * Must be called synchronously inside the `drop` handler so `dataTransfer`
 * metadata is captured before any `await`.
 */
export async function resolveFileDragData(
  dataTransfer: DataTransfer
): Promise<FileDragData | null> {
  // Capture all DOM DataTransfer fields synchronously before yielding to IPC.
  const syncData = readFileDragData(dataTransfer);
  if (syncData) return syncData;

  const expectedNames = Array.from(dataTransfer.files ?? [])
    .map((file) => file.name)
    .filter((name) => name.length > 0);
  const types = Array.from(dataTransfer.types ?? []);
  const hasOsFiles = expectedNames.length > 0 || types.includes("Files");
  if (!hasOsFiles) return null;

  try {
    const nativePaths = await invoke<string[]>("get_native_drag_file_paths");
    const uniqueNative = uniquePaths(nativePaths);
    const verified = matchPasteboardPathsToExpectedNames(uniqueNative, expectedNames);
    if (verified.length > 0) {
      return { kind: "file", paths: verified };
    }
  } catch (error) {
    console.error("Failed to read native drag file paths:", error);
  }

  return null;
}

/** Helper to execute a resolved drop onto `destDir` using Finder copy/move rules. */
export function resolveExecutableDrop(
  sourcePaths: readonly string[],
  destDir: string,
  modifiers: { altKey: boolean; metaKey: boolean }
): { operation: "copy" | "move"; paths: string[] } | null {
  const operation = resolveFileDropOperation(sourcePaths, destDir, modifiers);
  const paths = filterDropPathsForTarget(sourcePaths, destDir, operation);
  if (paths.length === 0) return null;
  return { operation, paths };
}

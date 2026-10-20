import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const FILE_DRAG_MIME = "application/x-imageexplorer-file";

export interface FileDragData {
  kind: "file";
  paths: string[];
}

interface ActiveNativeFileDrag {
  sessionId: string;
  paths: string[];
}

interface NativeFileDragEnded {
  sessionId: string;
}

const NATIVE_FILE_DRAG_ENDED_EVENT = "native-file-drag-ended";
const ACTIVE_DRAG_EXPIRY_MS = 30_000;
const DRAG_END_GRACE_PERIOD_MS = 250;

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

void listen<NativeFileDragEnded>(NATIVE_FILE_DRAG_ENDED_EVENT, ({ payload }) => {
  // AppKit finishes the destination's drop callback before notifying the
  // source. Keep a short guard for the WebView event bridge so an internal
  // drop can still recover the source paths.
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

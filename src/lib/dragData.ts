import { invoke } from "@tauri-apps/api/core";

export const FILE_DRAG_MIME = "application/x-imageexplorer-file";

export interface FileDragData {
  kind: "file";
  paths: string[];
}

function uniquePaths(paths: string[]) {
  return [...new Set(paths.filter((path) => path.length > 0))];
}

/** Return the rendered thumbnail for the native drag image when it is ready. */
export function getFileDragIcon(container: Element) {
  return (
    container.querySelector<HTMLImageElement>('img[src^="data:image/png;base64,"]')?.src ?? null
  );
}

export function startNativeFileDrag(paths: string[], icon: string | null) {
  return invoke("start_native_file_drag", { paths: uniquePaths(paths), icon });
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
  return paths.length > 0 ? { kind: "file", paths } : null;
}

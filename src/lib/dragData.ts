export const FILE_DRAG_MIME = "application/x-imageexplorer-file";

export interface FileDragData {
  kind: "file";
  paths: string[];
}

export function serializeFileDragData(paths: string[]) {
  return JSON.stringify({ kind: "file", paths });
}

export function readFileDragData(dataTransfer: DataTransfer): FileDragData | null {
  const raw =
    dataTransfer.getData(FILE_DRAG_MIME) ||
    dataTransfer.getData("application/json") ||
    dataTransfer.getData("text/plain");
  if (!raw) return null;

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

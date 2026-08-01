import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

const grantedDirectories = new Set<string>();

function isVolumePath(path: string) {
  return path === "/Volumes" || path.startsWith("/Volumes/");
}

function isWithinDirectory(path: string, directory: string) {
  return path === directory || path.startsWith(`${directory}/`);
}

export function isPermissionDeniedError(error: unknown) {
  return /operation not permitted|permission denied|os error 1/i.test(String(error));
}

export async function requestDirectoryAccess(path: string, title: string) {
  const selected = await open({
    directory: true,
    multiple: false,
    title,
    defaultPath: path,
  });

  if (typeof selected !== "string" || !selected) {
    return null;
  }

  // Confirm access before changing the current tab. The dialog grants the
  // selected folder a security-scoped sandbox extension for this process.
  await invoke("get_entries", { path: selected });
  grantedDirectories.add(selected);
  return selected;
}

export async function ensureDirectoryAccess(path: string, title: string) {
  if (!isVolumePath(path)) {
    return path;
  }

  for (const directory of grantedDirectories) {
    if (isWithinDirectory(path, directory)) {
      return path;
    }
  }

  try {
    await invoke("get_entries", { path });
    grantedDirectories.add(path);
    return path;
  } catch (error) {
    if (!isPermissionDeniedError(error)) {
      throw error;
    }
  }

  return requestDirectoryAccess(path, title);
}

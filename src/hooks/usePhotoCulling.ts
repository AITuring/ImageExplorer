import { useEffect, useSyncExternalStore } from "react";
import type { FileEntry } from "@/types";
import {
  getPhotoCullingMap,
  getPhotoCullingSnapshotVersion,
  hydratePhotoCullingStates,
  subscribePhotoCulling,
  type PhotoCullingState,
} from "@/lib/photoCulling";

/**
 * Hydrate SQLite star ratings and Pick/Reject flags for the active folder and
 * subscribe to updates without recreating listeners on every render.
 */
export function usePhotoCulling(entries: FileEntry[]): ReadonlyMap<string, PhotoCullingState> {
  const version = useSyncExternalStore(
    subscribePhotoCulling,
    getPhotoCullingSnapshotVersion,
    getPhotoCullingSnapshotVersion
  );

  useEffect(() => {
    const filePaths = entries.filter((entry) => !entry.is_dir).map((entry) => entry.path);
    if (filePaths.length === 0) return;
    void hydratePhotoCullingStates(filePaths);
  }, [entries]);

  // Reference `version` so React re-renders consumers whenever culling state changes.
  void version;
  return getPhotoCullingMap();
}

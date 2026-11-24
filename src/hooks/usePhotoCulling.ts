import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { FileEntry } from "@/types";
import {
  getPhotoCullingEntry,
  getPhotoCullingMap,
  getPhotoCullingSnapshotVersion,
  hydratePhotoCullingStates,
  subscribePhotoCulling,
  subscribePhotoCullingPath,
  type PhotoCullingState,
} from "@/lib/photoCulling";

const noopSubscribe = () => () => undefined;
const zeroSnapshot = () => 0;

/**
 * Hydrate SQLite star ratings and Pick/Reject flags for the active folder.
 * When `subscribeToAll` is false, updates still flow to per-path subscribers
 * (`usePhotoCullingEntry`) without re-rendering the entire FileList.
 */
export function usePhotoCulling(
  entries: FileEntry[],
  subscribeToAll = true
): ReadonlyMap<string, PhotoCullingState> {
  const version = useSyncExternalStore(
    subscribeToAll ? subscribePhotoCulling : noopSubscribe,
    subscribeToAll ? getPhotoCullingSnapshotVersion : zeroSnapshot,
    subscribeToAll ? getPhotoCullingSnapshotVersion : zeroSnapshot
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

/** Per-path culling subscription so rating/flagging 1 photo only re-renders that card. */
export function usePhotoCullingEntry(
  path: string | null | undefined,
  enabled = true
): PhotoCullingState | undefined {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!enabled || !path) return () => undefined;
      return subscribePhotoCullingPath(path, listener);
    },
    [enabled, path]
  );
  const getSnapshot = useCallback(
    () => (enabled && path ? getPhotoCullingEntry(path) : undefined),
    [enabled, path]
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

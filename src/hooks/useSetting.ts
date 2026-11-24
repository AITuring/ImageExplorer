import { useCallback, useEffect, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { settingsManager } from "@/lib/store";

const valueCache = new Map<string, unknown>();
const loadedKeys = new Set<string>();
const inflightLoads = new Set<string>();
const keyListeners = new Map<string, Set<() => void>>();
let globalListenerStarted = false;

function notifyKey(key: string) {
  const bucket = keyListeners.get(key);
  if (!bucket) return;
  for (const listener of bucket) {
    listener();
  }
}

function ensureGlobalSettingsListener() {
  if (globalListenerStarted) return;
  globalListenerStarted = true;
  void listen<{ key: string; value: unknown }>("setting-changed", (event) => {
    const { key, value } = event.payload;
    loadedKeys.add(key);
    if (Object.is(valueCache.get(key), value)) return;
    valueCache.set(key, value);
    notifyKey(key);
  }).catch(() => {
    globalListenerStarted = false;
  });
}

function ensureKeyLoaded(key: string) {
  if (loadedKeys.has(key) || inflightLoads.has(key)) return;
  inflightLoads.add(key);
  void settingsManager
    .get<unknown>(key)
    .then((stored) => {
      loadedKeys.add(key);
      if (stored !== null && stored !== undefined && !Object.is(valueCache.get(key), stored)) {
        valueCache.set(key, stored);
        notifyKey(key);
      }
    })
    .catch(() => undefined)
    .finally(() => {
      inflightLoads.delete(key);
    });
}

function subscribeKey(key: string, listener: () => void): () => void {
  ensureGlobalSettingsListener();
  let bucket = keyListeners.get(key);
  if (!bucket) {
    bucket = new Set();
    keyListeners.set(key, bucket);
  }
  bucket.add(listener);
  return () => {
    bucket?.delete(listener);
    if (bucket && bucket.size === 0) {
      keyListeners.delete(key);
    }
  };
}

export function useSetting<T>(key: string, defaultValue: T): [T, (val: T) => Promise<void>] {
  const subscribe = useCallback((listener: () => void) => subscribeKey(key, listener), [key]);
  const getSnapshot = useCallback(
    () => (valueCache.has(key) ? (valueCache.get(key) as T) : defaultValue),
    [defaultValue, key]
  );

  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    ensureGlobalSettingsListener();
    ensureKeyLoaded(key);
  }, [key]);

  const updateValue = useCallback(
    async (newValue: T) => {
      loadedKeys.add(key);
      if (!Object.is(valueCache.get(key), newValue)) {
        valueCache.set(key, newValue);
        notifyKey(key);
      }
      await settingsManager.set(key, newValue);
    },
    [key]
  );

  return [value, updateValue];
}

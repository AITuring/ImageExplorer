import { create } from "zustand";
import { settingsManager } from "@/lib/store";

const FAVORITES_KEY = "favorite_paths";
const RECENT_LOCATIONS_KEY = "recent_locations";
const HIDDEN_SIDEBAR_PATHS_KEY = "hidden_sidebar_paths";
const MAX_RECENT_LOCATIONS = 6;

interface LocationsState {
  favorites: string[];
  recentLocations: string[];
  hiddenSidebarPaths: string[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  toggleFavorite: (path: string) => Promise<void>;
  removeFavorite: (path: string) => Promise<void>;
  addRecentLocation: (path: string) => Promise<void>;
  removeRecentLocation: (path: string) => Promise<void>;
  hideSidebarPath: (path: string) => Promise<void>;
  restoreSidebarPaths: () => Promise<void>;
}

function isUsefulRecentPath(path: string): boolean {
  const normalized = path.replace(/\/+$/, "");
  if (/^\/(?:private\/)?(?:tmp|var\/folders)(?:\/|$)/.test(normalized)) return false;
  if (/^\/(?:System|Applications|Library)(?:\/|$)/.test(normalized)) return false;
  if (/^\/Volumes\/[^/]+$/.test(normalized)) return false;
  const home = normalized.match(/^(\/Users\/[^/]+)(?:\/(.*))?$/);
  if (
    home &&
    (!home[2] ||
      /^Library(?:\/|$)/.test(home[2]) ||
      /^(?:Downloads|Documents|Desktop|Music)$/.test(home[2]))
  ) {
    return false;
  }
  return true;
}

function normalizeRecentPaths(value: unknown): string[] {
  return normalizePaths(value).filter(isUsefulRecentPath).slice(0, MAX_RECENT_LOCATIONS);
}

function normalizePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.filter((path): path is string => typeof path === "string" && path.length > 0)),
  ];
}

async function savePaths(key: string, paths: string[]) {
  await settingsManager.set(key, paths);
}

export const useLocations = create<LocationsState>((set, get) => ({
  favorites: [],
  recentLocations: [],
  hiddenSidebarPaths: [],
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    const [storedFavorites, storedRecent, storedHidden] = await Promise.all([
      settingsManager.get<unknown>(FAVORITES_KEY),
      settingsManager.get<unknown>(RECENT_LOCATIONS_KEY),
      settingsManager.get<unknown>(HIDDEN_SIDEBAR_PATHS_KEY),
    ]);
    set({
      favorites: normalizePaths(storedFavorites),
      recentLocations: normalizeRecentPaths(storedRecent),
      hiddenSidebarPaths: normalizePaths(storedHidden),
      hydrated: true,
    });
  },

  toggleFavorite: async (path) => {
    const favorites = get().favorites.includes(path)
      ? get().favorites.filter((favorite) => favorite !== path)
      : [path, ...get().favorites];
    set({ favorites });
    await savePaths(FAVORITES_KEY, favorites);
  },

  removeFavorite: async (path) => {
    const favorites = get().favorites.filter((favorite) => favorite !== path);
    set({ favorites });
    await savePaths(FAVORITES_KEY, favorites);
  },

  addRecentLocation: async (path) => {
    if (!path || path.startsWith("smart://") || !isUsefulRecentPath(path)) return;
    const recentLocations = [
      path,
      ...get().recentLocations.filter((recent) => recent !== path),
    ].slice(0, MAX_RECENT_LOCATIONS);
    set({ recentLocations });
    await savePaths(RECENT_LOCATIONS_KEY, recentLocations);
  },

  removeRecentLocation: async (path) => {
    const recentLocations = get().recentLocations.filter((recent) => recent !== path);
    set({ recentLocations });
    await savePaths(RECENT_LOCATIONS_KEY, recentLocations);
  },

  hideSidebarPath: async (path) => {
    const hiddenSidebarPaths = [...new Set([...get().hiddenSidebarPaths, path])];
    set({ hiddenSidebarPaths });
    await savePaths(HIDDEN_SIDEBAR_PATHS_KEY, hiddenSidebarPaths);
  },

  restoreSidebarPaths: async () => {
    set({ hiddenSidebarPaths: [] });
    await savePaths(HIDDEN_SIDEBAR_PATHS_KEY, []);
  },
}));

export function getLocationName(path: string) {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (!trimmed) return path;
  return trimmed.split(/[\\/]/).pop() || trimmed;
}

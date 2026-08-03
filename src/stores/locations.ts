import { create } from "zustand";
import { settingsManager } from "@/lib/store";

const FAVORITES_KEY = "favorite_paths";
const RECENT_LOCATIONS_KEY = "recent_locations";
const MAX_RECENT_LOCATIONS = 12;

interface LocationsState {
  favorites: string[];
  recentLocations: string[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  toggleFavorite: (path: string) => Promise<void>;
  removeFavorite: (path: string) => Promise<void>;
  addRecentLocation: (path: string) => Promise<void>;
  removeRecentLocation: (path: string) => Promise<void>;
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
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    const [storedFavorites, storedRecent] = await Promise.all([
      settingsManager.get<unknown>(FAVORITES_KEY),
      settingsManager.get<unknown>(RECENT_LOCATIONS_KEY),
    ]);
    set({
      favorites: normalizePaths(storedFavorites),
      recentLocations: normalizePaths(storedRecent).slice(0, MAX_RECENT_LOCATIONS),
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
    if (!path || path.startsWith("smart://")) return;
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
}));

export function getLocationName(path: string) {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (!trimmed) return path;
  return trimmed.split(/[\\/]/).pop() || trimmed;
}

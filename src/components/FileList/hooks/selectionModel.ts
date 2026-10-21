import type { FileEntry } from "@/types";

export interface SelectionState {
  selectedPaths: string[];
  focusedPath: string | null;
  anchorPath: string | null;
}

export type SelectionAction =
  | { type: "single"; path: string }
  | { type: "toggle"; path: string }
  | { type: "range"; entries: FileEntry[]; toIndex: number }
  | { type: "all"; entries: FileEntry[] }
  | { type: "clear" }
  | { type: "set"; path: string | null }
  | { type: "prune"; paths: string[] };

export const initialSelection: SelectionState = {
  selectedPaths: [],
  focusedPath: null,
  anchorPath: null,
};

export function selectionReducer(
  state: SelectionState,
  action: SelectionAction,
): SelectionState {
  switch (action.type) {
    case "single":
      return { selectedPaths: [action.path], focusedPath: action.path, anchorPath: action.path };
    case "toggle": {
      const selected = state.selectedPaths.includes(action.path);
      const selectedPaths = selected
        ? state.selectedPaths.filter((path) => path !== action.path)
        : [...state.selectedPaths, action.path];
      const focusedPath = selected
        ? state.focusedPath === action.path
          ? (selectedPaths[selectedPaths.length - 1] ?? null)
          : state.focusedPath
        : action.path;
      return { selectedPaths, focusedPath, anchorPath: action.path };
    }
    case "range": {
      const target = action.entries[action.toIndex];
      if (!target) return state;

      const currentAnchor = state.anchorPath ?? state.focusedPath;
      const foundAnchorIndex = currentAnchor
        ? action.entries.findIndex((entry) => entry.path === currentAnchor)
        : -1;
      const anchorIndex = foundAnchorIndex >= 0 ? foundAnchorIndex : action.toIndex;
      const start = Math.min(anchorIndex, action.toIndex);
      const end = Math.max(anchorIndex, action.toIndex);
      const selectedPaths = action.entries.slice(start, end + 1).map((entry) => entry.path);
      return {
        selectedPaths,
        focusedPath: target.path,
        anchorPath: foundAnchorIndex >= 0 ? currentAnchor : target.path,
      };
    }
    case "all": {
      const selectedPaths = action.entries.map((entry) => entry.path);
      const focusedPath = state.focusedPath && selectedPaths.includes(state.focusedPath)
        ? state.focusedPath
        : (selectedPaths[selectedPaths.length - 1] ?? null);
      return { selectedPaths, focusedPath, anchorPath: focusedPath };
    }
    case "clear":
      return initialSelection;
    case "set":
      return action.path
        ? { selectedPaths: [action.path], focusedPath: action.path, anchorPath: action.path }
        : initialSelection;
    case "prune": {
      const available = new Set(action.paths);
      const selectedPaths = state.selectedPaths.filter((path) => available.has(path));
      const focusedPath = state.focusedPath && available.has(state.focusedPath)
        ? state.focusedPath
        : (selectedPaths[0] ?? null);
      const anchorPath = state.anchorPath && available.has(state.anchorPath)
        ? state.anchorPath
        : focusedPath;
      if (
        selectedPaths.length === state.selectedPaths.length &&
        focusedPath === state.focusedPath &&
        anchorPath === state.anchorPath
      ) {
        return state;
      }
      return { selectedPaths, focusedPath, anchorPath };
    }
  }
}

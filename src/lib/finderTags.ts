export interface FinderTagPreset {
  /** Canonical tag name written to macOS NSURLTagNamesKey. */
  id: string;
  /** Localized aliases that macOS Finder may store for the same built-in color. */
  aliases: readonly string[];
  color: string;
  labelKey: string;
}

export const FINDER_TAG_PRESETS: readonly FinderTagPreset[] = [
  { id: "Red", aliases: ["red", "红色"], color: "#ff3b30", labelKey: "tags.red" },
  { id: "Orange", aliases: ["orange", "橙色"], color: "#ff9500", labelKey: "tags.orange" },
  { id: "Yellow", aliases: ["yellow", "黄色"], color: "#ffcc00", labelKey: "tags.yellow" },
  { id: "Green", aliases: ["green", "绿色"], color: "#34c759", labelKey: "tags.green" },
  { id: "Blue", aliases: ["blue", "蓝色"], color: "#007aff", labelKey: "tags.blue" },
  { id: "Purple", aliases: ["purple", "紫色"], color: "#af52de", labelKey: "tags.purple" },
  { id: "Gray", aliases: ["gray", "grey", "灰色"], color: "#8e8e93", labelKey: "tags.gray" },
] as const;

const DEFAULT_CUSTOM_TAG_COLOR = "#8e8e93";

export function matchFinderTagPreset(tagName: string): FinderTagPreset | undefined {
  const normalized = tagName.trim().toLowerCase();
  if (!normalized) return undefined;
  return FINDER_TAG_PRESETS.find((preset) => preset.aliases.includes(normalized));
}

export function getFinderTagColor(tagName: string): string {
  return matchFinderTagPreset(tagName)?.color ?? DEFAULT_CUSTOM_TAG_COLOR;
}

export function hasFinderTag(tags: readonly string[] | undefined, presetId: string): boolean {
  if (!tags || tags.length === 0) return false;
  const preset = matchFinderTagPreset(presetId);
  if (!preset) {
    const normalized = presetId.trim().toLowerCase();
    return tags.some((tag) => tag.trim().toLowerCase() === normalized);
  }
  return tags.some((tag) => preset.aliases.includes(tag.trim().toLowerCase()));
}

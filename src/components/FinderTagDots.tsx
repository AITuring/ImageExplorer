import { memo } from "react";
import { getFinderTagColor } from "@/lib/finderTags";

interface FinderTagDotsProps {
  tags?: string[];
  maxDots?: number;
  size?: "sm" | "md";
}

/** Compact macOS Finder-style colored tag dots displayed beside filenames. */
export const FinderTagDots = memo(function FinderTagDots({
  tags,
  maxDots = 3,
  size = "sm",
}: FinderTagDotsProps) {
  if (!tags || tags.length === 0) return null;

  const visible = tags.slice(0, maxDots);
  const dotSizeClass = size === "md" ? "h-2.5 w-2.5" : "h-2 w-2";

  return (
    <span
      className="inline-flex shrink-0 items-center gap-0.5"
      title={tags.join(", ")}
      aria-label={tags.join(", ")}
    >
      {visible.map((tag) => (
        <span
          key={tag}
          className={`${dotSizeClass} inline-block rounded-full ring-1 ring-black/15 dark:ring-white/20`}
          style={{ backgroundColor: getFinderTagColor(tag) }}
        />
      ))}
    </span>
  );
});

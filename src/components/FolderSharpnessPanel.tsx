import { memo, useMemo, useState } from "react";
import { Scan, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  getLatestSharpnessMap,
  isSharpnessAnalyzable,
  useSharpnessStoreVersion,
  type VisibleSharpness,
} from "@/hooks/useVisibleSharpness";
import type { FileEntry } from "@/types";

interface Props {
  entries: FileEntry[];
  verdicts?: ReadonlyMap<string, VisibleSharpness>;
  enabled: boolean;
  onLocate: (entry: FileEntry) => void;
}

export const FolderSharpnessPanel = memo(function FolderSharpnessPanel({
  entries,
  verdicts: externalVerdicts,
  enabled,
  onLocate,
}: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  // Subscribe to sharpness store updates directly so scanning a folder never
  // forces the parent FileList to re-render just to update this badge.
  const storeVersion = useSharpnessStoreVersion(enabled && !externalVerdicts);
  const verdicts = externalVerdicts ?? getLatestSharpnessMap();
  const photos = useMemo(() => entries.filter(isSharpnessAnalyzable), [entries]);
  const { soft, doneCount, unavailable, completed } = useMemo(() => {
    void storeVersion;
    const softList: FileEntry[] = [];
    let done = 0;
    let unavailableCount = 0;
    for (const entry of photos) {
      const verdict = verdicts.get(entry.path);
      if (verdict) {
        done += 1;
        if (verdict === "soft") softList.push(entry);
        else if (verdict === "unavailable") unavailableCount += 1;
      }
    }
    return {
      soft: softList,
      doneCount: done,
      unavailable: unavailableCount,
      completed: photos.length > 0 && done === photos.length,
    };
  }, [photos, storeVersion, verdicts]);
  const hasMultipleParents = useMemo(() => {
    let firstParent: string | null = null;
    for (const entry of soft) {
      const parent = entry.path.slice(0, entry.path.lastIndexOf("/")) || "/";
      if (firstParent === null) {
        firstParent = parent;
      } else if (parent !== firstParent) {
        return true;
      }
    }
    return false;
  }, [soft]);

  if (!enabled || photos.length === 0) return null;

  if (!completed || !expanded || soft.length === 0) {
    return (
      <button
        type="button"
        className="bg-background/90 border-border/80 hover:bg-accent/80 absolute right-3 bottom-3 z-20 flex max-w-[90%] items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs shadow-md backdrop-blur-md transition-colors disabled:opacity-80"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={() => setExpanded(true)}
        aria-expanded={false}
        disabled={!completed || soft.length === 0}
      >
        <Scan className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden="true" />
        <span role="status" className="truncate">
          {!completed
            ? t("folder_sharpness.scanning", { done: doneCount, total: photos.length })
            : t("folder_sharpness.summary", { count: soft.length, unavailable })}
        </span>
      </button>
    );
  }

  return (
    <aside
      aria-label={t("folder_sharpness.title")}
      onMouseDown={(event) => event.stopPropagation()}
      className="bg-background/92 border-border/80 absolute right-3 bottom-3 z-20 flex max-h-[min(320px,52%)] w-64 max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-xl border shadow-xl backdrop-blur-xl"
    >
      <div className="border-border/50 flex shrink-0 items-center justify-between gap-2 border-b px-2.5 py-2">
        <h2 className="flex min-w-0 items-center gap-1.5 truncate text-xs font-medium">
          <Scan className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden="true" />
          <span className="truncate">
            {t("folder_sharpness.title")} · {soft.length}
          </span>
        </h2>
        <button
          type="button"
          className="text-muted-foreground hover:bg-muted hover:text-foreground rounded p-0.5 transition-colors"
          aria-label={t("folder_sharpness.close")}
          onClick={() => setExpanded(false)}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="text-muted-foreground shrink-0 px-2.5 pt-1.5 pb-1 text-[11px] leading-4">
        {t("folder_sharpness.hint")}
      </p>
      {unavailable > 0 && (
        <p className="text-muted-foreground shrink-0 px-2.5 pb-1 text-[11px] leading-4">
          {t("folder_sharpness.unavailable", { count: unavailable })}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
        {soft.map((entry) => (
          <button
            key={entry.path}
            type="button"
            title={entry.path}
            className="hover:bg-accent/80 focus-visible:ring-primary block w-full rounded-md px-2 py-1 text-left transition-colors focus-visible:ring-2"
            onClick={() => onLocate(entry)}
          >
            <span className="block truncate text-xs leading-5">{entry.name}</span>
            {hasMultipleParents && (
              <span className="text-muted-foreground block truncate text-[10px] leading-3.5">
                {entry.path.slice(0, entry.path.lastIndexOf("/")) || "/"}
              </span>
            )}
          </button>
        ))}
      </div>
    </aside>
  );
});

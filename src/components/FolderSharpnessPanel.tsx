import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  portalToTabBar?: boolean;
  onLocate: (entry: FileEntry) => void;
}

export const FolderSharpnessPanel = memo(function FolderSharpnessPanel({
  entries,
  verdicts: externalVerdicts,
  enabled,
  portalToTabBar = true,
  onLocate,
}: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [slotElement, setSlotElement] = useState<HTMLElement | null>(() =>
    portalToTabBar && typeof document !== "undefined"
      ? document.getElementById("tabbar-status-slot")
      : null
  );

  useEffect(() => {
    if (!portalToTabBar) return;
    const el = document.getElementById("tabbar-status-slot");
    if (el && el !== slotElement) {
      queueMicrotask(() => setSlotElement(el));
    }
  }, [portalToTabBar, slotElement]);

  useEffect(() => {
    if (!expanded) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setExpanded(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setExpanded(false);
      }
    };
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [expanded]);

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

  if (!enabled || !portalToTabBar || photos.length === 0 || !slotElement) return null;

  const canExpand = completed && soft.length > 0;
  const pillContent = (
    <div ref={containerRef} className="relative flex shrink-0 items-center">
      <button
        type="button"
        className={`border-border/60 bg-muted/55 hover:bg-accent/80 flex h-6 max-w-60 items-center gap-1.5 rounded-full border px-2.5 text-[11px] leading-none transition-colors disabled:opacity-80 ${
          expanded ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
        }`}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={() => {
          if (canExpand) setExpanded((prev) => !prev);
        }}
        aria-expanded={canExpand ? expanded : false}
        disabled={!canExpand}
      >
        <Scan className="h-3 w-3 shrink-0 text-amber-500" aria-hidden="true" />
        <span role="status" className="truncate tabular-nums">
          {!completed
            ? t("folder_sharpness.scanning", { done: doneCount, total: photos.length })
            : t("folder_sharpness.summary", { count: soft.length, unavailable })}
        </span>
      </button>

      {canExpand && expanded && (
        <aside
          aria-label={t("folder_sharpness.title")}
          onMouseDown={(event) => event.stopPropagation()}
          className="bg-background/95 border-border/80 absolute top-full right-0 z-50 mt-1.5 flex max-h-[min(360px,55vh)] w-72 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border shadow-xl backdrop-blur-xl"
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
                onClick={() => {
                  onLocate(entry);
                  setExpanded(false);
                }}
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
      )}
    </div>
  );

  if (portalToTabBar && slotElement) {
    return createPortal(pillContent, slotElement);
  }
  return pillContent;
});

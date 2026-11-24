import { useMemo, useState } from "react";
import { Scan, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isSharpnessAnalyzable, type VisibleSharpness } from "@/hooks/useVisibleSharpness";
import type { FileEntry } from "@/types";

interface Props {
  entries: FileEntry[];
  verdicts: Map<string, VisibleSharpness>;
  enabled: boolean;
  onLocate: (entry: FileEntry) => void;
}

export function FolderSharpnessPanel({ entries, verdicts, enabled, onLocate }: Props) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(false);
  const photos = useMemo(() => entries.filter(isSharpnessAnalyzable), [entries]);
  const soft = useMemo(
    () => photos.filter((entry) => verdicts.get(entry.path) === "soft"),
    [photos, verdicts]
  );
  const unavailable = photos.filter((entry) => verdicts.get(entry.path) === "unavailable").length;
  const completed = photos.length > 0 && photos.every((entry) => verdicts.has(entry.path));
  if (!enabled || photos.length === 0) return null;

  if (!completed || dismissed || soft.length === 0) {
    return (
      <button
        type="button"
        className="bg-background/95 border-border absolute right-3 bottom-3 z-20 flex max-w-[90%] items-center gap-2 rounded-lg border px-3 py-2 text-xs shadow-sm"
        onClick={() => setDismissed(false)}
        aria-expanded={false}
        disabled={!completed || soft.length === 0}
      >
        <Scan className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span role="status">
          {!completed
            ? t("folder_sharpness.scanning", { done: verdicts.size, total: photos.length })
            : t("folder_sharpness.summary", { count: soft.length, unavailable })}
        </span>
      </button>
    );
  }

  return (
    <aside
      aria-label={t("folder_sharpness.title")}
      className="bg-background/95 border-border absolute top-3 right-3 bottom-3 z-20 flex w-80 max-w-[calc(100%-1.5rem)] flex-col rounded-xl border shadow-xl"
    >
      <div className="flex items-center justify-between gap-2 p-3">
        <h2 className="text-sm font-medium">
          {t("folder_sharpness.title")} · {soft.length}
        </h2>
        <button
          type="button"
          className="hover:bg-muted rounded p-1"
          aria-label={t("folder_sharpness.close")}
          onClick={() => setDismissed(true)}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <p className="text-muted-foreground px-3 pb-3 text-xs">{t("folder_sharpness.hint")}</p>
      {unavailable > 0 && (
        <p className="text-muted-foreground px-3 pb-3 text-xs">
          {t("folder_sharpness.unavailable", { count: unavailable })}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {soft.map((entry) => (
          <button
            key={entry.path}
            type="button"
            title={entry.path}
            className="hover:bg-muted focus-visible:ring-primary block w-full rounded-md p-2 text-left focus-visible:ring-2"
            onClick={() => onLocate(entry)}
          >
            <span className="block truncate text-sm">{entry.name}</span>
            <span className="text-muted-foreground block truncate text-xs">
              {entry.path.slice(0, entry.path.lastIndexOf("/")) || "/"}
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}

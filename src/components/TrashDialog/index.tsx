import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useTrashDialog } from "@/stores/trashDialog";
import type { TrashEntry } from "@/types/trash";

function formatSize(size: number | null) {
  if (size === null) return "—";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function TrashDialog() {
  const { t } = useTranslation();
  const open = useTrashDialog((state) => state.open);
  const setOpen = useTrashDialog((state) => state.setOpen);
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEntries(await invoke<TrashEntry[]>("list_trash"));
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const restore = async (entry: TrashEntry) => {
    if (!entry.can_restore) return;
    try {
      await invoke("restore_trash_entry", { entryId: entry.id });
      await refresh();
    } catch (restoreError) {
      setError(String(restoreError));
    }
  };

  const empty = async () => {
    if (!window.confirm(t("trash.empty_confirm"))) return;
    try {
      await invoke("empty_trash");
      await refresh();
    } catch (emptyError) {
      setError(String(emptyError));
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="h-5 w-5" aria-hidden="true" />
            {t("trash.title")}
          </DialogTitle>
          <DialogDescription>{t("trash.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between">
          <span className="text-muted-foreground text-sm">
            {t("trash.count", { count: entries.length })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} aria-hidden="true" />
            {t("trash.refresh")}
          </Button>
        </div>

        <div className="bg-muted/30 max-h-[min(52vh,460px)] overflow-y-auto rounded-md border">
          {loading && (
            <p className="text-muted-foreground p-6 text-center text-sm">{t("trash.loading")}</p>
          )}
          {!loading && error && <p className="text-destructive p-6 text-center text-sm">{error}</p>}
          {!loading && !error && entries.length === 0 && (
            <p className="text-muted-foreground p-6 text-center text-sm">{t("trash.empty")}</p>
          )}
          {!loading && !error && entries.length > 0 && (
            <ul className="divide-border divide-y">
              {entries.map((entry) => (
                <li key={entry.id} className="flex items-center gap-3 px-3 py-2.5">
                  <Trash2 className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" title={entry.name}>
                      {entry.name}
                    </p>
                    <p
                      className="text-muted-foreground truncate text-xs"
                      title={entry.original_path ?? undefined}
                    >
                      {entry.original_path ?? t("trash.original_unknown")} ·{" "}
                      {formatSize(entry.size)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={!entry.can_restore}
                    onClick={() => void restore(entry)}
                    title={t("trash.restore")}
                    aria-label={t("trash.restore_item", { name: entry.name })}
                  >
                    <RotateCcw aria-hidden="true" />
                    {t("trash.restore")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void empty()}
            disabled={loading || entries.length === 0}
          >
            <Trash2 aria-hidden="true" />
            {t("trash.empty_action")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

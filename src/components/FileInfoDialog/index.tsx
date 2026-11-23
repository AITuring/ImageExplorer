import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { File, Folder, Link, Package, Info, Loader2, Lock, Unlock } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFileInfoDialog } from "@/stores/fileInfoDialog";
import { FINDER_TAG_PRESETS, hasFinderTag } from "@/lib/finderTags";
import { invalidateCache } from "@/lib/entriesCache";
import type { FileEntry } from "@/types";
import { formatFileSize } from "@/utils/format";

interface DirectorySizeSummary {
  path: string;
  total_bytes: number;
  file_count: number;
  dir_count: number;
}

function formatTimestamp(value: number | null | undefined) {
  if (value === null || value === undefined) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value * 1000));
}

function formatMode(mode: number | null | undefined) {
  if (mode === null || mode === undefined) return null;
  return `0${(mode & 0o7777).toString(8).padStart(4, "0")}`;
}

function formatOwner(details: FileEntry): string | null {
  if (details.owner_name || details.group_name) {
    const owner = details.owner_name ?? details.uid?.toString() ?? "—";
    const group = details.group_name ?? details.gid?.toString() ?? "—";
    return `${owner} (${group})`;
  }
  if (details.uid === null || details.uid === undefined) return null;
  return `${details.uid}:${details.gid ?? "—"}`;
}

export function FileInfoDialog() {
  const { t } = useTranslation();
  const entry = useFileInfoDialog((state) => state.entry);
  const close = useFileInfoDialog((state) => state.close);
  const [loadedEntry, setLoadedEntry] = useState<FileEntry | null>(null);
  const [dirSize, setDirSize] = useState<DirectorySizeSummary | null>(null);
  const [calculatingSize, setCalculatingSize] = useState(false);
  const [updatingLock, setUpdatingLock] = useState(false);
  const sizeRequestIdRef = useRef(0);

  useEffect(() => {
    if (!entry) return;

    let cancelled = false;
    invoke<FileEntry>("get_file_entry", { path: entry.path })
      .then((freshEntry) => {
        if (!cancelled) setLoadedEntry(freshEntry);
      })
      .catch(() => {
        // Search results can refer to an item that disappeared. The original
        // lightweight entry remains useful and keeps the dialog readable.
      });
    return () => {
      cancelled = true;
    };
  }, [entry]);

  const details = entry && loadedEntry?.path === entry.path ? loadedEntry : entry;
  const dirTargetPath = details?.is_dir ? details.path : null;

  useEffect(() => {
    if (!dirTargetPath) return;

    let cancelled = false;
    const requestId = Date.now() * 1000 + ((sizeRequestIdRef.current += 1) % 1000);

    const run = async () => {
      setCalculatingSize(true);
      try {
        const summary = await invoke<DirectorySizeSummary>("calculate_directory_size", {
          path: dirTargetPath,
          requestId,
        });
        if (!cancelled) {
          setDirSize(summary);
        }
      } catch {
        // Cancelled or unreadable directory; leave size as fallback.
      } finally {
        if (!cancelled) {
          setCalculatingSize(false);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
      void invoke("cancel_directory_size", { requestId: requestId + 1 }).catch(() => undefined);
    };
  }, [dirTargetPath]);

  const handleToggleTag = useCallback(
    async (tagId: string) => {
      if (!details) return;
      try {
        const updatedTags = await invoke<string[]>("toggle_file_tag", {
          paths: [details.path],
          tag: tagId,
        });
        const parent = details.path.slice(0, details.path.lastIndexOf("/")) || "/";
        invalidateCache(parent);
        setLoadedEntry({ ...details, tags: updatedTags });
        window.dispatchEvent(
          new CustomEvent("finder-tags-updated", {
            detail: { parentPath: parent, path: details.path },
          })
        );
      } catch (error) {
        console.error("Failed to toggle Finder tag:", error);
      }
    },
    [details]
  );

  const handleToggleLocked = useCallback(async () => {
    if (!details || updatingLock) return;
    const nextLocked = !details.is_locked;
    setUpdatingLock(true);
    try {
      const confirmedLocked = await invoke<boolean>("set_file_locked", {
        path: details.path,
        locked: nextLocked,
      });
      const parent = details.path.slice(0, details.path.lastIndexOf("/")) || "/";
      invalidateCache(parent);
      setLoadedEntry({ ...details, is_locked: confirmedLocked });
      window.dispatchEvent(
        new CustomEvent("finder-tags-updated", {
          detail: { parentPath: parent, path: details.path },
        })
      );
    } catch (error) {
      console.error("Failed to toggle file lock:", error);
      alert(t("file_info.lock_failed", { error: String(error) }));
    } finally {
      setUpdatingLock(false);
    }
  }, [details, t, updatingLock]);

  const matchingDirSize = details?.is_dir && dirSize?.path === details.path ? dirSize : null;

  const sizeValue = useMemo(() => {
    if (!details) return null;
    if (!details.is_dir) return formatFileSize(details.size);
    if (matchingDirSize) {
      return t("file_info.size_folder_detail", {
        size:
          matchingDirSize.total_bytes === 0 ? "0 B" : formatFileSize(matchingDirSize.total_bytes),
        files: matchingDirSize.file_count,
        dirs: matchingDirSize.dir_count,
      });
    }
    return calculatingSize ? t("file_info.size_calculating") : "—";
  }, [calculatingSize, details, matchingDirSize, t]);

  const rows = useMemo(() => {
    if (!details) return [];
    const values: Array<[string, string | null]> = [
      [t("file_info.kind"), details.is_dir ? t("file_info.folder") : t("file_info.file")],
      [t("file_info.path"), details.path],
      [t("file_info.size"), sizeValue],
      [t("file_info.modified"), formatTimestamp(details.modified)],
      [t("file_info.created"), formatTimestamp(details.created)],
      [t("file_info.accessed"), formatTimestamp(details.accessed)],
      [t("file_info.readonly"), details.readonly ? t("common.yes") : t("common.no")],
      [t("file_info.mode"), formatMode(details.mode)],
      [t("file_info.owner"), formatOwner(details)],
      [t("file_info.file_attributes"), details.file_attributes?.toString() ?? null],
      [t("file_info.symlink_target"), details.symlink_target ?? null],
      [t("file_info.alias_target"), details.alias_target ?? null],
      [t("file_info.package_type"), details.package_type ?? null],
    ];
    return values.filter(([, value]) => value !== null);
  }, [details, sizeValue, t]);

  return (
    <Dialog open={Boolean(entry)} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2">
            {details?.is_symlink || details?.is_alias ? (
              <Link className="h-5 w-5 shrink-0" aria-hidden="true" />
            ) : details?.is_package ? (
              <Package className="h-5 w-5 shrink-0" aria-hidden="true" />
            ) : details?.is_dir ? (
              <Folder className="h-5 w-5 shrink-0" aria-hidden="true" />
            ) : details ? (
              <File className="h-5 w-5 shrink-0" aria-hidden="true" />
            ) : (
              <Info className="h-5 w-5 shrink-0" aria-hidden="true" />
            )}
            <span className="truncate">{details?.name ?? t("file_info.title")}</span>
            {details?.is_locked && (
              <Lock
                className="text-muted-foreground h-3.5 w-3.5 shrink-0"
                aria-label={t("file_info.locked")}
              />
            )}
          </DialogTitle>
          <DialogDescription>{t("file_info.description")}</DialogDescription>
        </DialogHeader>

        {details && (
          <dl className="max-h-[min(58vh,520px)] space-y-2 overflow-y-auto pr-1 text-sm">
            {details.is_package && (
              <div className="bg-muted/50 rounded-md px-3 py-2">
                <dt className="text-muted-foreground text-xs">{t("file_info.package")}</dt>
                <dd className="font-medium">
                  {t("file_info.package_value", { type: details.package_type ?? "" })}
                </dd>
              </div>
            )}
            {details.is_alias && (
              <div className="bg-muted/50 rounded-md px-3 py-2">
                <dt className="text-muted-foreground text-xs">{t("file_info.alias")}</dt>
                <dd className="font-medium">{t("file_info.alias_value")}</dd>
              </div>
            )}
            {details.is_symlink && (
              <div className="bg-muted/50 rounded-md px-3 py-2">
                <dt className="text-muted-foreground text-xs">{t("file_info.symlink")}</dt>
                <dd className="font-medium">{t("file_info.symlink_value")}</dd>
              </div>
            )}

            <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3 border-b pb-2">
              <dt className="text-muted-foreground">{t("file_info.tags")}</dt>
              <dd className="flex flex-wrap items-center gap-1.5">
                {FINDER_TAG_PRESETS.map((preset) => {
                  const active = hasFinderTag(details.tags, preset.id);
                  const label = t(preset.labelKey);
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => void handleToggleTag(preset.id)}
                      aria-pressed={active}
                      title={label}
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors ${
                        active
                          ? "border-foreground/30 bg-accent text-foreground font-medium"
                          : "border-border/60 text-muted-foreground hover:bg-accent/50"
                      }`}
                    >
                      <span
                        className="h-2 w-2 rounded-full ring-1 ring-black/15"
                        style={{ backgroundColor: preset.color }}
                      />
                      <span>{label}</span>
                    </button>
                  );
                })}
              </dd>
            </div>

            <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3 border-b pb-2">
              <dt className="text-muted-foreground">{t("file_info.locked")}</dt>
              <dd className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  role="switch"
                  aria-checked={Boolean(details.is_locked)}
                  disabled={updatingLock}
                  onClick={() => void handleToggleLocked()}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                    details.is_locked
                      ? "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300"
                      : "border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
                >
                  {updatingLock ? (
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                  ) : details.is_locked ? (
                    <Lock className="h-3 w-3" aria-hidden="true" />
                  ) : (
                    <Unlock className="h-3 w-3" aria-hidden="true" />
                  )}
                  <span>{details.is_locked ? t("common.yes") : t("common.no")}</span>
                </button>
                <span className="text-muted-foreground text-xs">{t("file_info.locked_hint")}</span>
              </dd>
            </div>

            {rows.map(([label, value]) => (
              <div
                key={label}
                className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 border-b pb-2 last:border-b-0"
              >
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="flex min-w-0 items-center gap-1.5 font-mono text-xs break-words">
                  {label === t("file_info.size") &&
                    details.is_dir &&
                    calculatingSize &&
                    !matchingDirSize && (
                      <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
                    )}
                  <span className="min-w-0 break-words">{value}</span>
                </dd>
              </div>
            ))}
          </dl>
        )}
      </DialogContent>
    </Dialog>
  );
}

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { File, Folder, Link, Package, Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFileInfoDialog } from "@/stores/fileInfoDialog";
import type { FileEntry } from "@/types";
import { formatFileSize } from "@/utils/format";

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

export function FileInfoDialog() {
  const { t } = useTranslation();
  const entry = useFileInfoDialog((state) => state.entry);
  const close = useFileInfoDialog((state) => state.close);
  const [loadedEntry, setLoadedEntry] = useState<FileEntry | null>(null);

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

  const rows = useMemo(() => {
    if (!details) return [];
    const values: Array<[string, string | null]> = [
      [t("file_info.kind"), details.is_dir ? t("file_info.folder") : t("file_info.file")],
      [t("file_info.path"), details.path],
      [t("file_info.size"), details.is_dir ? "—" : formatFileSize(details.size)],
      [t("file_info.modified"), formatTimestamp(details.modified)],
      [t("file_info.created"), formatTimestamp(details.created)],
      [t("file_info.accessed"), formatTimestamp(details.accessed)],
      [t("file_info.readonly"), details.readonly ? t("common.yes") : t("common.no")],
      [t("file_info.mode"), formatMode(details.mode)],
      [
        t("file_info.owner"),
        details.uid === null || details.uid === undefined
          ? null
          : `${details.uid}:${details.gid ?? "—"}`,
      ],
      [t("file_info.file_attributes"), details.file_attributes?.toString() ?? null],
      [t("file_info.symlink_target"), details.symlink_target ?? null],
      [t("file_info.alias_target"), details.alias_target ?? null],
      [t("file_info.package_type"), details.package_type ?? null],
    ];
    return values.filter(([, value]) => value !== null);
  }, [details, t]);

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
            {rows.map(([label, value]) => (
              <div
                key={label}
                className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 border-b pb-2 last:border-b-0"
              >
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="min-w-0 font-mono text-xs break-words">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </DialogContent>
    </Dialog>
  );
}

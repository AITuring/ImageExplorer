import { PhotoInspector } from "./PhotoInspector";
import { SharpnessBadge } from "./PhotoDetails";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { FileEntry } from "@/types";
import { FileThumbnail } from "@/components/FileThumbnail";
import { usePhotoMetadata } from "@/hooks/usePhotoMetadata";
import { useVisibleSharpness } from "@/hooks/useVisibleSharpness";
import { isAnalyzablePhoto } from "@/lib/photoAnalysis";

export function ColumnFilePreview({ entry }: { entry: FileEntry }) {
  const { t } = useTranslation();
  const metadata = usePhotoMetadata(entry);
  const entries = useMemo(() => [entry], [entry]);
  const verdict = useVisibleSharpness(entries, isAnalyzablePhoto(entry), entry.path).get(
    entry.path
  );

  return (
    <aside
      className="finder-column-preview flex h-full min-w-72 flex-1 flex-col items-center gap-4 overflow-y-auto p-6"
      aria-label={t("file_list.preview")}
    >
      <div className="flex min-h-48 w-full flex-1 items-center justify-center">
        <FileThumbnail
          key={entry.path}
          entry={entry}
          size={512}
          requestSizeOverride={1024}
          className="max-h-[55vh] w-full object-contain"
          fallbackClassName="h-24 w-24 text-muted-foreground"
        />
      </div>
      <h2 className="w-full text-center text-sm font-medium break-all">{entry.name}</h2>
      {isAnalyzablePhoto(entry) && <SharpnessBadge verdict={verdict} />}
      <PhotoInspector key={entry.path} entry={entry} metadata={metadata} />
    </aside>
  );
}

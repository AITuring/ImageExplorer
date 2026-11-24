import { memo } from "react";
import { Check, Star, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PhotoInspector } from "./PhotoInspector";
import { SharpnessBadge } from "./PhotoDetails";
import type { FileEntry } from "@/types";
import { FileThumbnail } from "@/components/FileThumbnail";
import { usePhotoMetadata } from "@/hooks/usePhotoMetadata";
import { usePhotoSharpness } from "@/hooks/useVisibleSharpness";
import { usePhotoCullingEntry } from "@/hooks/usePhotoCulling";
import { isAnalyzablePhoto } from "@/lib/photoAnalysis";

export const ColumnFilePreview = memo(function ColumnFilePreview({
  entry,
  onDoubleClick,
}: {
  entry: FileEntry;
  onDoubleClick?: (entry: FileEntry) => void;
}) {
  const { t } = useTranslation();
  const isPhoto = isAnalyzablePhoto(entry);
  const metadata = usePhotoMetadata(entry, true);
  const verdict = usePhotoSharpness(entry.path, isPhoto);
  const culling = usePhotoCullingEntry(entry.path, isPhoto);

  return (
    <aside
      className="finder-column-preview flex h-full min-w-80 flex-1 flex-col items-center gap-3 overflow-y-auto p-5"
      aria-label={t("file_list.preview")}
    >
      <div
        className="relative flex h-[48vh] min-h-56 w-full shrink-0 items-center justify-center overflow-hidden rounded-md"
        onDoubleClick={() => onDoubleClick?.(entry)}
      >
        <FileThumbnail
          key={entry.path}
          entry={entry}
          size={640}
          requestSizeOverride={1600}
          className="max-h-full max-w-full rounded-md object-contain shadow-sm"
          fallbackClassName="h-24 w-24 text-muted-foreground"
        />
      </div>
      <div className="flex w-full flex-wrap items-center justify-center gap-2">
        <h2 className="max-w-full text-center text-sm font-medium break-all">{entry.name}</h2>
        {isPhoto && <SharpnessBadge verdict={verdict} />}
        {culling?.flag === "pick" && (
          <span className="inline-flex items-center gap-0.5 rounded bg-emerald-500/20 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
            <Check className="h-3 w-3" aria-hidden="true" />
            {t("file_list.culling.pick")}
          </span>
        )}
        {culling?.flag === "reject" && (
          <span className="bg-destructive/20 text-destructive inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] font-medium">
            <XCircle className="h-3 w-3" aria-hidden="true" />
            {t("file_list.culling.reject")}
          </span>
        )}
        {culling && culling.rating > 0 && (
          <span className="inline-flex items-center gap-0.5 text-amber-400">
            {Array.from({ length: culling.rating }).map((_, idx) => (
              <Star key={idx} className="h-3 w-3 fill-amber-400 text-amber-400" />
            ))}
          </span>
        )}
      </div>
      <PhotoInspector key={entry.path} entry={entry} metadata={metadata} />
    </aside>
  );
});

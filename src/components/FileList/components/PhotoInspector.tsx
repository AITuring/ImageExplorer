import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { FileEntry } from "@/types";
import { formatDate, formatFileSize } from "@/utils/format";
import {
  formatAperture,
  formatFocalLength,
  formatShutterSpeed,
  type PhotoMetadata,
} from "@/lib/photoMetadata";

export function PhotoInspector({
  entry,
  metadata,
}: {
  entry: FileEntry;
  metadata: PhotoMetadata | null | undefined;
}) {
  const { t } = useTranslation();
  const [showMap, setShowMap] = useState(false);
  const label = (key: string) => t(`file_list.details.${key}`);
  const sections = [
    {
      title: "shooting",
      rows: [
        ["iso", metadata?.iso ? `ISO ${metadata.iso}` : null],
        ["aperture", formatAperture(metadata?.aperture ?? null)],
        ["shutter", formatShutterSpeed(metadata?.shutterSpeed ?? null)],
        ["focal", formatFocalLength(metadata?.focalLength ?? null)],
        ["captured", metadata?.capturedAt?.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1/$2/$3")],
      ],
    },
    {
      title: "equipment",
      rows: [
        ["make", metadata?.make],
        ["model", metadata?.model],
        ["lens", metadata?.lens],
      ],
    },
    {
      title: "file",
      rows: [
        [
          "dimensions",
          metadata?.width && metadata?.height
            ? `${metadata.width} × ${metadata.height} px · ${((metadata.width * metadata.height) / 1e6).toFixed(1)} MP`
            : null,
        ],
        ["size", formatFileSize(entry.size)],
        ["modified", formatDate(entry.modified)],
        ["type", entry.name.split(".").pop()?.toUpperCase()],
      ],
    },
  ];
  const lat = metadata?.latitude;
  const lon = metadata?.longitude;
  const hasGps =
    typeof lat === "number" &&
    typeof lon === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180;
  const mapUrl = hasGps
    ? `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(`${Math.max(-180, lon - 0.01)},${Math.max(-90, lat - 0.006)},${Math.min(180, lon + 0.01)},${Math.min(90, lat + 0.006)}`)}&layer=mapnik&marker=${lat},${lon}`
    : "";
  return (
    <div className="w-full max-w-xl space-y-4 text-[11px] leading-4">
      {sections.map((section) => {
        const rows = section.rows.filter(([, value]) => value);
        if (!rows.length) return null;
        return (
          <section
            key={section.title}
            className="border-border/50 bg-secondary/20 rounded-lg border p-3"
          >
            <h3 className="mb-3 text-xs font-medium">{label(section.title)}</h3>
            <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-4 gap-y-2">
              {rows.map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-muted-foreground">{label(key!)}</dt>
                  <dd className="min-w-0 break-words tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        );
      })}
      {hasGps && (
        <section className="border-border/50 bg-secondary/20 overflow-hidden rounded-lg border">
          <div className="space-y-2 p-3">
            <h3 className="text-xs font-medium">{label("location")}</h3>
            <p className="text-muted-foreground tabular-nums">
              {label("latitude")}: {lat.toFixed(6)}° · {label("longitude")}: {lon.toFixed(6)}°
            </p>
            {!showMap && (
              <>
                <p className="text-muted-foreground">{label("map_notice")}</p>
                <button
                  type="button"
                  className="bg-secondary hover:bg-accent rounded px-3 py-1.5 focus-visible:ring-2"
                  onClick={() => setShowMap(true)}
                >
                  {label("load_map")}
                </button>
              </>
            )}
          </div>
          {showMap && (
            <iframe
              title={label("location")}
              src={mapUrl}
              className="h-56 w-full border-0"
              referrerPolicy="no-referrer"
              sandbox="allow-scripts allow-same-origin allow-popups"
            />
          )}
        </section>
      )}
    </div>
  );
}

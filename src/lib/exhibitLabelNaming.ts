export interface ParsedExhibitEntry {
  era: string;
  name: string;
  provenance: string;
  collection: string;
  accessionNumber: string;
}

export interface ExhibitNamingOptions {
  includeEra: boolean;
  includeProvenance: boolean;
  includeCollection: boolean;
  separator: "-" | "_";
}

export const DEFAULT_EXHIBIT_NAMING_OPTIONS: ExhibitNamingOptions = {
  includeEra: true,
  includeProvenance: true,
  includeCollection: true,
  separator: "-",
};

export function sanitizeExhibitSegment(raw: string): string {
  return raw
    .trim()
    .replace(/^[:：,，.。;；()（）-]+|[:：,，.。;；()（）-]+$/g, "")
    .replace(/[/\\:*?"<>|\r\n]+/g, "")
    .replace(/\s+/g, "");
}

/**
 * Format museum object filename per `exhibit-label-photo-renaming` SKILL.md:
 * `时代-名称-出土地-馆藏-原图片名.ext`, omitting any empty/unknown fields while
 * preserving camera number, `_1` suffixes, and extension.
 */
export function formatExhibitFilename(
  entry: ParsedExhibitEntry | null | undefined,
  cameraStem: string,
  extension: string,
  options: ExhibitNamingOptions = DEFAULT_EXHIBIT_NAMING_OPTIONS
): string | null {
  if (!entry) return null;
  const name = sanitizeExhibitSegment(entry.name);
  if (!name) return null;

  const parts: string[] = [];
  if (options.includeEra) {
    const era = sanitizeExhibitSegment(entry.era);
    if (era) parts.push(era);
  }
  parts.push(name);
  if (options.includeProvenance) {
    const prov = sanitizeExhibitSegment(entry.provenance);
    if (prov) parts.push(prov);
  }
  if (options.includeCollection) {
    const col = sanitizeExhibitSegment(entry.collection);
    if (col) parts.push(col);
  }
  parts.push(cameraStem.trim());

  const joined = parts.join(options.separator);
  return extension ? `${joined}.${extension}` : joined;
}

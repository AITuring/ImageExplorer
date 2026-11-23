export interface PairableFileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  extension?: string | null;
}

const RAW_PAIR_EXTENSIONS = new Set([
  "arw",
  "cr2",
  "cr3",
  "nef",
  "nrw",
  "raf",
  "orf",
  "rw2",
  "pef",
  "srw",
  "dcr",
  "kdc",
  "3fr",
  "iiq",
  "x3f",
  "dng",
]);

const COMPANION_PAIR_EXTENSIONS = new Set(["jpg", "jpeg", "heic", "heif"]);

function getExtension(entry: PairableFileEntry): string {
  if (entry.extension) return entry.extension.toLowerCase();
  const dot = entry.name.lastIndexOf(".");
  return dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : "";
}

function getStemKey(entry: PairableFileEntry): string | null {
  if (entry.is_dir || entry.name.startsWith("._")) return null;
  const dot = entry.name.lastIndexOf(".");
  if (dot <= 0) return null;
  const slash = entry.path.lastIndexOf("/");
  const parent = slash > 0 ? entry.path.slice(0, slash) : "/";
  return `${parent}\0${entry.name.slice(0, dot).toLowerCase()}`;
}

export interface RawJpegPairingResult<T extends PairableFileEntry> {
  entries: T[];
  companionsByPrimaryPath: Map<string, T[]>;
  pairCount: number;
}

/**
 * Collapse matching same-stem RAW + JPEG/HEIC files into a single primary RAW
 * entry while retaining companion references for badge rendering and linked
 * operations (delete, move, copy, tag).
 */
export function pairRawAndJpegEntries<T extends PairableFileEntry>(
  entries: T[]
): RawJpegPairingResult<T> {
  const rawsByStem = new Map<string, T>();
  const companionsByStem = new Map<string, T[]>();

  for (const entry of entries) {
    const stemKey = getStemKey(entry);
    if (!stemKey) continue;
    const ext = getExtension(entry);
    if (RAW_PAIR_EXTENSIONS.has(ext)) {
      if (!rawsByStem.has(stemKey)) {
        rawsByStem.set(stemKey, entry);
      }
    } else if (COMPANION_PAIR_EXTENSIONS.has(ext)) {
      const list = companionsByStem.get(stemKey);
      if (list) list.push(entry);
      else companionsByStem.set(stemKey, [entry]);
    }
  }

  const hiddenCompanionPaths = new Set<string>();
  const companionsByPrimaryPath = new Map<string, T[]>();

  for (const [stemKey, primaryRaw] of rawsByStem.entries()) {
    const companions = companionsByStem.get(stemKey);
    if (!companions || companions.length === 0) continue;
    companionsByPrimaryPath.set(primaryRaw.path, companions);
    for (const companion of companions) {
      hiddenCompanionPaths.add(companion.path);
    }
  }

  if (hiddenCompanionPaths.size === 0) {
    return { entries, companionsByPrimaryPath, pairCount: 0 };
  }

  return {
    entries: entries.filter((entry) => !hiddenCompanionPaths.has(entry.path)),
    companionsByPrimaryPath,
    pairCount: companionsByPrimaryPath.size,
  };
}

/**
 * Expand selected entries to also include any stacked companion JPEG/HEIC files
 * so delete/move/copy/tag operations stay synchronized across RAW+JPG pairs.
 */
export function expandPairedEntries<T extends PairableFileEntry>(
  targets: T[],
  companionsByPrimaryPath: ReadonlyMap<string, T[]>
): T[] {
  if (companionsByPrimaryPath.size === 0 || targets.length === 0) return targets;
  const seen = new Set<string>();
  const expanded: T[] = [];
  for (const target of targets) {
    if (!seen.has(target.path)) {
      seen.add(target.path);
      expanded.push(target);
    }
    const companions = companionsByPrimaryPath.get(target.path);
    if (companions) {
      for (const companion of companions) {
        if (!seen.has(companion.path)) {
          seen.add(companion.path);
          expanded.push(companion);
        }
      }
    }
  }
  return expanded;
}

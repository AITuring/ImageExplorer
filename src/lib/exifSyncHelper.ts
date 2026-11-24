export interface ExifFields {
  make: string | null;
  model: string | null;
  lens: string | null;
  iso: string | null;
  aperture: string | null;
  shutterSpeed: string | null;
  focalLength: string | null;
  capturedAt: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface ExifPhotoAudit {
  path: string;
  fileName: string;
  extension: string;
  modified: number | null;
  size: number;
  writable: boolean;
  metadata: ExifFields;
  missingTime: boolean;
  missingCameraLens: boolean;
  missingExposure: boolean;
  missingGps: boolean;
  suggestedSourcePath: string | null;
}

export interface ExifFolderInspection {
  directory: string;
  totalPhotos: number;
  missingExifCount: number;
  missingGpsCount: number;
  photos: ExifPhotoAudit[];
}

export interface ExifPatchItem {
  path: string;
  make: string | null;
  model: string | null;
  lens: string | null;
  iso: string | null;
  aperture: string | null;
  shutterSpeed: string | null;
  focalLength: string | null;
  capturedAt: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface ExifSyncApplyRequest {
  items: ExifPatchItem[];
  overwriteExisting: boolean;
  syncFileMtime: boolean;
}

export interface ExifSyncApplyResult {
  updated: number;
  unchanged: number;
  failed: string[];
  updatedPaths: string[];
}

export interface ExifFieldToggles {
  time: boolean;
  cameraLens: boolean;
  exposure: boolean;
  gps: boolean;
}

export interface ExifPreset {
  id: string;
  name: string;
  fields: ExifFields;
}

export const EMPTY_EXIF_FIELDS: ExifFields = {
  make: null,
  model: null,
  lens: null,
  iso: null,
  aperture: null,
  shutterSpeed: null,
  focalLength: null,
  capturedAt: null,
  latitude: null,
  longitude: null,
};

function cleanStr(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parses coordinate pairs pasted from Apple Maps / Google Maps / Amap / Baidu:
 * - "32.0415, 118.7892"
 * - "32.0415，118.7892"
 * - "32.0415 118.7892"
 * - "32.0415° N, 118.7892° E"
 */
export function parseGpsCoordinatePair(
  raw: string
): { latitude: number; longitude: number } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const normalized = trimmed.replace(/[，;；\t]+/g, ",").replace(/\s*,\s*/g, ",");
  const parts = normalized.includes(",")
    ? normalized.split(",").filter(Boolean)
    : normalized.split(/\s+/).filter(Boolean);

  if (parts.length !== 2) return null;

  const parseAxis = (token: string, negativeHemisphere: RegExp): number | null => {
    const cleaned = token.trim().replace(/°/g, "");
    const match = cleaned.match(/^([+-]?\d+(?:\.\d+)?)\s*([NSEWnsew])?$/);
    if (!match) return null;
    let value = Number(match[1]);
    if (!Number.isFinite(value)) return null;
    if (match[2] && negativeHemisphere.test(match[2])) {
      value = -Math.abs(value);
    }
    return value;
  };

  const lat = parseAxis(parts[0], /^[Ss]$/);
  const lon = parseAxis(parts[1], /^[Ww]$/);
  if (lat === null || lon === null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  return {
    latitude: Number(lat.toFixed(6)),
    longitude: Number(lon.toFixed(6)),
  };
}

/**
 * Formats an EXIF datetime string and shifts it by `offsetSeconds`.
 * Output is always canonical EXIF `"YYYY:MM:DD HH:MM:SS"`.
 */
export function incrementExifDatetime(
  raw: string | null | undefined,
  offsetSeconds: number
): string | null {
  const trimmed = cleanStr(raw);
  if (!trimmed) return null;
  const normalized = trimmed.replace("T", " ");
  const match = normalized.match(
    /^(\d{4})[:/-](\d{1,2})[:/-](\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/
  );
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] ? Number(match[6]) : 0;

  if (
    year < 1900 ||
    year > 2200 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  // Use UTC arithmetic so local DST boundaries never skew the +1s offset.
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second) + offsetSeconds * 1000;
  const shifted = new Date(utcMs);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(shifted.getUTCFullYear(), 4)}:${pad(shifted.getUTCMonth() + 1)}:${pad(
    shifted.getUTCDate()
  )} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
}

/**
 * Converts decimal shutter speeds like "0.004" into photographer-friendly "1/250".
 */
export function formatShutterDisplay(raw: string | null | undefined): string {
  const trimmed = cleanStr(raw);
  if (!trimmed) return "";
  if (trimmed.includes("/")) return trimmed;
  const val = Number(trimmed.replace(/s$/i, ""));
  if (!Number.isFinite(val) || val <= 0) return trimmed;
  if (val < 1) {
    const recip = Math.round(1 / val);
    if (recip >= 2 && Math.abs(1 / val - recip) / recip < 0.05) {
      return `1/${recip}`;
    }
    return `${Number(val.toFixed(4))}`;
  }
  return `${Number(val.toFixed(2))}s`;
}

export function buildExifPatchFromFields(
  path: string,
  fields: ExifFields,
  toggles: ExifFieldToggles,
  timeOffsetSeconds = 0
): ExifPatchItem {
  const capturedAt = toggles.time
    ? incrementExifDatetime(fields.capturedAt, timeOffsetSeconds)
    : null;
  const validGps =
    toggles.gps &&
    typeof fields.latitude === "number" &&
    typeof fields.longitude === "number" &&
    Number.isFinite(fields.latitude) &&
    Number.isFinite(fields.longitude) &&
    fields.latitude >= -90 &&
    fields.latitude <= 90 &&
    fields.longitude >= -180 &&
    fields.longitude <= 180;

  return {
    path,
    make: toggles.cameraLens ? cleanStr(fields.make) : null,
    model: toggles.cameraLens ? cleanStr(fields.model) : null,
    lens: toggles.cameraLens ? cleanStr(fields.lens) : null,
    iso: toggles.exposure ? cleanStr(fields.iso) : null,
    aperture: toggles.exposure ? cleanStr(fields.aperture) : null,
    shutterSpeed: toggles.exposure ? cleanStr(fields.shutterSpeed) : null,
    focalLength: toggles.exposure ? cleanStr(fields.focalLength) : null,
    capturedAt,
    latitude: validGps ? fields.latitude : null,
    longitude: validGps ? fields.longitude : null,
  };
}

export function hasAnyPatchValue(patch: ExifPatchItem): boolean {
  return Boolean(
    patch.make ||
    patch.model ||
    patch.lens ||
    patch.iso ||
    patch.aperture ||
    patch.shutterSpeed ||
    patch.focalLength ||
    patch.capturedAt ||
    (patch.latitude !== null && patch.longitude !== null)
  );
}

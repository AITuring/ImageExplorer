export interface PhotoHistogramData {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  luma: Uint32Array;
  totalPixels: number;
  highlightClipRatio: number;
  shadowClipRatio: number;
  /** Normalization peak (computed from bins 2..253 when non-empty so clipped extremes do not crush midtones). */
  scalePeak: number;
}

export function computeHistogramFromRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number
): PhotoHistogramData {
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const luma = new Uint32Array(256);

  const pixelCount = Math.min(Math.floor(rgba.length / 4), Math.max(0, width * height));
  let highlightClipped = 0;
  let shadowClipped = 0;

  for (let i = 0; i < pixelCount; i++) {
    const offset = i * 4;
    const rv = rgba[offset];
    const gv = rgba[offset + 1];
    const bv = rgba[offset + 2];

    r[rv] += 1;
    g[gv] += 1;
    b[bv] += 1;

    // Rec. 709 luma approximation
    const lv = Math.min(255, Math.round(0.2126 * rv + 0.7152 * gv + 0.0722 * bv));
    luma[lv] += 1;

    if (rv >= 254 && gv >= 254 && bv >= 254) {
      highlightClipped += 1;
    } else if (rv <= 1 && gv <= 1 && bv <= 1) {
      shadowClipped += 1;
    }
  }

  let interiorPeak = 0;
  for (let bin = 2; bin <= 253; bin++) {
    const binMax = Math.max(r[bin], g[bin], b[bin], luma[bin]);
    if (binMax > interiorPeak) interiorPeak = binMax;
  }

  let globalPeak = interiorPeak;
  if (globalPeak === 0) {
    for (let bin = 0; bin < 256; bin++) {
      const binMax = Math.max(r[bin], g[bin], b[bin], luma[bin]);
      if (binMax > globalPeak) globalPeak = binMax;
    }
  }

  return {
    r,
    g,
    b,
    luma,
    totalPixels: pixelCount,
    highlightClipRatio: pixelCount > 0 ? highlightClipped / pixelCount : 0,
    shadowClipRatio: pixelCount > 0 ? shadowClipped / pixelCount : 0,
    scalePeak: Math.max(1, globalPeak),
  };
}

/**
 * Produce an RGBA overlay where blown highlights (>=254 across RGB) are painted
 * red and crushed shadows (<=1 across RGB) are painted blue.
 */
export function buildClippingMaskRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number
): Uint8ClampedArray {
  const pixelCount = Math.min(Math.floor(rgba.length / 4), Math.max(0, width * height));
  const out = new Uint8ClampedArray(pixelCount * 4);

  for (let i = 0; i < pixelCount; i++) {
    const offset = i * 4;
    const rv = rgba[offset];
    const gv = rgba[offset + 1];
    const bv = rgba[offset + 2];

    if (rv >= 254 && gv >= 254 && bv >= 254) {
      out[offset] = 239;
      out[offset + 1] = 68;
      out[offset + 2] = 68;
      out[offset + 3] = 205;
    } else if (rv <= 1 && gv <= 1 && bv <= 1) {
      out[offset] = 59;
      out[offset + 1] = 130;
      out[offset + 2] = 246;
      out[offset + 3] = 205;
    }
  }

  return out;
}

export function extractHistogramFromImageElement(
  image: HTMLImageElement,
  maxDim = 256,
  includeClippingMask = false
): { histogram: PhotoHistogramData; clippingMaskUrl: string | null } | null {
  const naturalWidth = image.naturalWidth;
  const naturalHeight = image.naturalHeight;
  if (!naturalWidth || !naturalHeight || typeof document === "undefined") {
    return null;
  }

  const scale = Math.min(1, maxDim / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  try {
    ctx.drawImage(image, 0, 0, width, height);
    const { data } = ctx.getImageData(0, 0, width, height);
    const histogram = computeHistogramFromRgba(data, width, height);

    let clippingMaskUrl: string | null = null;
    if (includeClippingMask) {
      const mask = buildClippingMaskRgba(data, width, height);
      const maskCanvas = document.createElement("canvas");
      maskCanvas.width = width;
      maskCanvas.height = height;
      const maskCtx = maskCanvas.getContext("2d");
      if (maskCtx) {
        const maskImageData = maskCtx.createImageData(width, height);
        maskImageData.data.set(mask);
        maskCtx.putImageData(maskImageData, 0, 0);
        clippingMaskUrl = maskCanvas.toDataURL("image/png");
      }
    }

    return { histogram, clippingMaskUrl };
  } catch {
    return null;
  }
}

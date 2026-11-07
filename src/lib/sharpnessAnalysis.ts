export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SharpnessMaskResult {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  highlightedPixels: number;
  highlightedRatio: number;
}

export interface SharpnessRegionPixels {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

const MAX_ANALYSIS_EDGE = 2048;
const FOCUS_TILE_SHIFT = 7;
const FOCUS_TILE_EDGE = 1 << FOCUS_TILE_SHIFT;
export const FULL_IMAGE_SHARPNESS_SOURCE_SIZE = 2048;
const MIN_SOURCE_REQUEST_SIZE = 2048;
const MAX_SOURCE_REQUEST_SIZE = 6144;
const SOURCE_SIZE_STEPS = [2048, 3072, 4096, 6144];
const MIN_ABSOLUTE_SHARPNESS = 12;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizedRectFromPoints(
  start: { x: number; y: number },
  end: { x: number; y: number }
): NormalizedRect {
  const startX = clamp(start.x, 0, 1);
  const startY = clamp(start.y, 0, 1);
  const endX = clamp(end.x, 0, 1);
  const endY = clamp(end.y, 0, 1);

  return {
    x: Math.min(startX, endX),
    y: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
  };
}

export function getSharpnessSourceRequestSize(
  selection: NormalizedRect,
  imageDimensions?: { width: number; height: number } | null
) {
  const imageAspect = imageDimensions
    ? imageDimensions.width / Math.max(imageDimensions.height, 1)
    : 1;
  const widthRelativeToLongEdge = imageAspect >= 1 ? 1 : imageAspect;
  const heightRelativeToLongEdge = imageAspect >= 1 ? 1 / imageAspect : 1;
  const smallestSelectionSpan = Math.max(
    0.08,
    Math.min(selection.width * widthRelativeToLongEdge, selection.height * heightRelativeToLongEdge)
  );
  const desiredSourceSize = clamp(
    Math.round(768 / smallestSelectionSpan),
    MIN_SOURCE_REQUEST_SIZE,
    MAX_SOURCE_REQUEST_SIZE
  );

  return (
    SOURCE_SIZE_STEPS.find((candidate) => candidate >= desiredSourceSize) ?? MAX_SOURCE_REQUEST_SIZE
  );
}

function percentileFromHistogram(histogram: Uint32Array, total: number, percentile: number) {
  if (total <= 0) return 0;
  const target = Math.max(1, Math.ceil(total * percentile));
  let seen = 0;

  for (let index = 0; index < histogram.length; index += 1) {
    seen += histogram[index];
    if (seen >= target) return index;
  }

  return histogram.length - 1;
}

/**
 * Builds a focus-peaking mask from RGBA pixels. The threshold is relative to
 * the selected area, but an absolute high-frequency floor prevents a uniformly
 * soft region from being presented as sharp merely because it contains the
 * strongest pixels in that region.
 */
export function computeSharpnessMask(
  pixels: Uint8ClampedArray,
  width: number,
  height: number
): SharpnessMaskResult {
  const pixelCount = width * height;
  const emptyMask = () => ({
    width,
    height,
    rgba: new Uint8ClampedArray(pixelCount * 4),
    highlightedPixels: 0,
    highlightedRatio: 0,
  });

  if (width < 9 || height < 9 || pixels.length < pixelCount * 4) {
    return emptyMask();
  }

  const luma = new Float32Array(pixelCount);
  const opaque = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    const pixelIndex = index * 4;
    luma[index] =
      pixels[pixelIndex] * 0.2126 +
      pixels[pixelIndex + 1] * 0.7152 +
      pixels[pixelIndex + 2] * 0.0722;
    opaque[index] = pixels[pixelIndex + 3] >= 192 ? 1 : 0;
  }

  // Reduce pixel-scale noise before measuring edge acutance.
  const filtered = new Float32Array(pixelCount);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      filtered[index] =
        (luma[index - width - 1] +
          2 * luma[index - width] +
          luma[index - width + 1] +
          2 * luma[index - 1] +
          4 * luma[index] +
          2 * luma[index + 1] +
          luma[index + width - 1] +
          2 * luma[index + width] +
          luma[index + width + 1]) /
        16;
    }
  }

  const scores = new Float32Array(pixelCount);
  const tileColumns = Math.ceil(width / FOCUS_TILE_EDGE);
  const tileRows = Math.ceil(height / FOCUS_TILE_EDGE);
  const tileLaplacian = new Float64Array(tileColumns * tileRows);
  const tileGradient = new Float64Array(tileColumns * tileRows);
  const histogram = new Uint32Array(1024);
  let validPixels = 0;
  let scoreSum = 0;
  let squaredScoreSum = 0;
  let maximumScore = 0;

  for (let y = 4; y < height - 4; y += 1) {
    const tileRow = (y >> FOCUS_TILE_SHIFT) * tileColumns;
    for (let x = 4; x < width - 4; x += 1) {
      const index = y * width + x;
      const left = index - 1;
      const right = index + 1;
      const top = index - width;
      const bottom = index + width;
      const topLeft = top - 1;
      const topRight = top + 1;
      const bottomLeft = bottom - 1;
      const bottomRight = bottom + 1;

      if (
        !opaque[index] ||
        !opaque[left] ||
        !opaque[right] ||
        !opaque[top] ||
        !opaque[bottom] ||
        !opaque[topLeft] ||
        !opaque[topRight] ||
        !opaque[bottomLeft] ||
        !opaque[bottomRight]
      ) {
        continue;
      }

      const horizontal =
        -filtered[topLeft] -
        filtered[left] * 2 -
        filtered[bottomLeft] +
        filtered[topRight] +
        filtered[right] * 2 +
        filtered[bottomRight];
      const vertical =
        -filtered[topLeft] -
        filtered[top] * 2 -
        filtered[topRight] +
        filtered[bottomLeft] +
        filtered[bottom] * 2 +
        filtered[bottomRight];
      const gradient = Math.sqrt(horizontal * horizontal + vertical * vertical) / 8;
      // A soft, high-contrast silhouette can have a large gradient while its
      // transition spans several pixels. Compare the central slope with the
      // contrast across the same edge at a wider scale.
      const stepX = Math.abs(horizontal) >= Math.abs(vertical) ? 1 : 0;
      const stepY = stepX ? 0 : 1;
      const offset = stepY * width + stepX;
      const broadContrast = Math.abs(filtered[index + offset * 3] - filtered[index - offset * 3]);
      const acutance = (gradient * 2) / Math.max(broadContrast, 1);
      const laplacian = Math.abs(
        filtered[index] * 4 - filtered[left] - filtered[right] - filtered[top] - filtered[bottom]
      );
      const score = acutance >= 0.38 ? laplacian * 0.68 + gradient * 0.32 : 0;

      // Compare fine detail with the broader edge energy in each local area.
      // A blurred silhouette may still have high contrast at a few pixels,
      // but its surrounding surface has less fine detail than a focused one.
      const rawLaplacian = Math.abs(
        luma[index] * 4 - luma[left] - luma[right] - luma[top] - luma[bottom]
      );
      const rawGradient = Math.abs(luma[left] - luma[right]) + Math.abs(luma[top] - luma[bottom]);
      const tile = tileRow + (x >> FOCUS_TILE_SHIFT);
      tileLaplacian[tile] += rawLaplacian;
      tileGradient[tile] += rawGradient;

      scores[index] = score;
      maximumScore = Math.max(maximumScore, score);
      scoreSum += score;
      squaredScoreSum += score * score;
      histogram[Math.min(histogram.length - 1, Math.floor(score))] += 1;
      validPixels += 1;
    }
  }

  if (validPixels === 0 || maximumScore < MIN_ABSOLUTE_SHARPNESS) {
    return emptyMask();
  }

  const mean = scoreSum / validPixels;
  const deviation = Math.sqrt(Math.max(0, squaredScoreSum / validPixels - mean * mean));
  const percentile88 = percentileFromHistogram(histogram, validPixels, 0.88);
  const percentile98 = percentileFromHistogram(histogram, validPixels, 0.98);
  const threshold = Math.max(MIN_ABSOLUTE_SHARPNESS, percentile88, mean + deviation * 0.65);
  const supportThreshold = Math.max(MIN_ABSOLUTE_SHARPNESS * 0.55, threshold * 0.55);
  const rgba = new Uint8ClampedArray(pixelCount * 4);
  const intensityRange = Math.max(8, percentile98 - threshold, maximumScore - threshold);
  const tileFocus = new Uint8Array(tileLaplacian.length);
  for (let tile = 0; tile < tileFocus.length; tile += 1) {
    tileFocus[tile] =
      tileGradient[tile] > 0 && tileLaplacian[tile] / tileGradient[tile] >= 0.66 ? 1 : 0;
  }
  let highlightedPixels = 0;

  for (let y = 1; y < height - 1; y += 1) {
    const tileRow = (y >> FOCUS_TILE_SHIFT) * tileColumns;
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if (scores[index] < threshold) continue;
      const tile = tileRow + (x >> FOCUS_TILE_SHIFT);
      if (!tileFocus[tile]) continue;

      let supportingNeighbors = 0;
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) continue;
          if (scores[index + offsetY * width + offsetX] >= supportThreshold) {
            supportingNeighbors += 1;
          }
        }
      }

      if (supportingNeighbors >= 2) {
        highlightedPixels += 1;
        const strength = clamp((scores[index] - threshold) / intensityRange, 0, 1);
        const pixelIndex = index * 4;
        rgba[pixelIndex] = 255;
        rgba[pixelIndex + 1] = 55;
        rgba[pixelIndex + 2] = 92;
        rgba[pixelIndex + 3] = Math.round(170 + strength * 85);

        // A one-pixel halo keeps focus peaking visible after the mask is
        // scaled to the preview without filling broad soft gradients.
        for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
          for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
            const neighborPixelIndex = (index + offsetY * width + offsetX) * 4;
            if (rgba[neighborPixelIndex + 3] >= 72) continue;
            rgba[neighborPixelIndex] = 255;
            rgba[neighborPixelIndex + 1] = 55;
            rgba[neighborPixelIndex + 2] = 92;
            rgba[neighborPixelIndex + 3] = 72;
          }
        }
      }
    }
  }

  const minimumUsefulPixels = Math.max(6, Math.floor(validPixels * 0.00005));
  if (highlightedPixels < minimumUsefulPixels) {
    return emptyMask();
  }

  return {
    width,
    height,
    rgba,
    highlightedPixels,
    highlightedRatio: highlightedPixels / validPixels,
  };
}

export function extractSharpnessRegionPixels(
  image: HTMLImageElement,
  selection: NormalizedRect,
  maxAnalysisEdge = MAX_ANALYSIS_EDGE
): SharpnessRegionPixels {
  const sourceWidth = image.naturalWidth;
  const sourceHeight = image.naturalHeight;
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error("Sharpness source image has no dimensions");
  }

  const startX = clamp(Math.floor(selection.x * sourceWidth), 0, sourceWidth - 1);
  const startY = clamp(Math.floor(selection.y * sourceHeight), 0, sourceHeight - 1);
  const endX = clamp(
    Math.ceil((selection.x + selection.width) * sourceWidth),
    startX + 1,
    sourceWidth
  );
  const endY = clamp(
    Math.ceil((selection.y + selection.height) * sourceHeight),
    startY + 1,
    sourceHeight
  );
  const selectedWidth = endX - startX;
  const selectedHeight = endY - startY;
  const analysisScale = Math.min(1, maxAnalysisEdge / Math.max(selectedWidth, selectedHeight));
  const analysisWidth = Math.max(1, Math.round(selectedWidth * analysisScale));
  const analysisHeight = Math.max(1, Math.round(selectedHeight * analysisScale));

  const canvas = document.createElement("canvas");
  canvas.width = analysisWidth;
  canvas.height = analysisHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Canvas 2D context is unavailable");
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    image,
    startX,
    startY,
    selectedWidth,
    selectedHeight,
    0,
    0,
    analysisWidth,
    analysisHeight
  );
  const imageData = context.getImageData(0, 0, analysisWidth, analysisHeight);
  return {
    width: analysisWidth,
    height: analysisHeight,
    pixels: imageData.data,
  };
}

export function analyzeSharpnessRegion(
  image: HTMLImageElement,
  selection: NormalizedRect
): SharpnessMaskResult {
  const region = extractSharpnessRegionPixels(image, selection);
  return computeSharpnessMask(region.pixels, region.width, region.height);
}

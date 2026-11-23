export interface PhotoFeatureKernelInput {
  rgba: Uint8ClampedArray;
  analysisSize: number;
  fingerprintSize: number;
  hashSize: number;
  focusGridSize: number;
  contentLeft: number;
  contentTop: number;
  contentWidth: number;
  contentHeight: number;
}

export interface PhotoFeatureKernelOutput {
  fingerprint: Float32Array;
  hashBits: Uint8Array;
  tileScores: Float32Array;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function normalizePhotoFingerprint(values: ArrayLike<number>): Float32Array {
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) sum += values[index];
  const mean = sum / Math.max(1, values.length);

  let variance = 0;
  for (let index = 0; index < values.length; index += 1) {
    const delta = values[index] - mean;
    variance += delta * delta;
  }
  const deviation = Math.sqrt(variance / Math.max(1, values.length)) || 1;
  const normalized = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    normalized[index] = clamp((values[index] - mean) / deviation, -3, 3) / 3;
  }
  return normalized;
}

/**
 * Pure pixel-level photo feature extractor (grayscale + normalized 16x16 fingerprint
 * + 8x8 dHash + 6x6 multi-scale Sobel/Laplacian tile sharpness scores).
 * Runs inside a Web Worker to keep the UI thread free during uncached folder scans.
 */
export function computePhotoFeaturesFromRgba(
  input: PhotoFeatureKernelInput
): PhotoFeatureKernelOutput {
  const {
    rgba,
    analysisSize,
    fingerprintSize,
    hashSize,
    focusGridSize,
    contentLeft,
    contentTop,
    contentWidth,
    contentHeight,
  } = input;

  const grayscale = new Float32Array(analysisSize * analysisSize);
  for (let pixelIndex = 0; pixelIndex < grayscale.length; pixelIndex += 1) {
    const rgbaIndex = pixelIndex * 4;
    grayscale[pixelIndex] =
      rgba[rgbaIndex] * 0.2126 + rgba[rgbaIndex + 1] * 0.7152 + rgba[rgbaIndex + 2] * 0.0722;
  }

  const fingerprintValues = new Float32Array(fingerprintSize * fingerprintSize);
  for (let row = 0; row < fingerprintSize; row += 1) {
    for (let column = 0; column < fingerprintSize; column += 1) {
      const sampleX = clamp(
        Math.floor(contentLeft + ((column + 0.5) * contentWidth) / fingerprintSize),
        0,
        analysisSize - 1
      );
      const sampleY = clamp(
        Math.floor(contentTop + ((row + 0.5) * contentHeight) / fingerprintSize),
        0,
        analysisSize - 1
      );
      fingerprintValues[row * fingerprintSize + column] =
        grayscale[sampleY * analysisSize + sampleX];
    }
  }

  const hashBits = new Uint8Array(hashSize * hashSize);
  for (let row = 0; row < hashSize; row += 1) {
    for (let column = 0; column < hashSize; column += 1) {
      const leftX = clamp(
        Math.floor(contentLeft + ((column + 0.25) * contentWidth) / hashSize),
        0,
        analysisSize - 1
      );
      const rightX = clamp(
        Math.floor(contentLeft + ((column + 1.25) * contentWidth) / hashSize),
        0,
        analysisSize - 1
      );
      const sampleY = clamp(
        Math.floor(contentTop + ((row + 0.5) * contentHeight) / hashSize),
        0,
        analysisSize - 1
      );
      hashBits[row * hashSize + column] =
        grayscale[sampleY * analysisSize + leftX] < grayscale[sampleY * analysisSize + rightX]
          ? 1
          : 0;
    }
  }

  const tileWidth = Math.max(8, Math.floor(contentWidth / focusGridSize));
  const tileHeight = Math.max(8, Math.floor(contentHeight / focusGridSize));
  const tileScores = new Float32Array(focusGridSize * focusGridSize);
  const maximumTileSamples = Math.max(1, (tileWidth - 2) * (tileHeight - 2));
  const gradientValues = new Float32Array(maximumTileSamples);
  const laplacianValues = new Float32Array(maximumTileSamples);

  for (let tileY = 0; tileY < focusGridSize; tileY += 1) {
    for (let tileX = 0; tileX < focusGridSize; tileX += 1) {
      const startX = contentLeft + tileX * tileWidth;
      const startY = contentTop + tileY * tileHeight;
      const endX = Math.min(contentLeft + contentWidth - 1, startX + tileWidth);
      const endY = Math.min(contentTop + contentHeight - 1, startY + tileHeight);
      let gradientSum = 0;
      let laplacianSum = 0;
      let horizontalEnergy = 0;
      let verticalEnergy = 0;
      let samples = 0;

      for (let y = startY + 1; y < endY - 1; y += 1) {
        for (let x = startX + 1; x < endX - 1; x += 1) {
          const pixelIndex = y * analysisSize + x;
          const center = grayscale[pixelIndex];
          const horizontal = Math.abs(grayscale[pixelIndex + 1] - grayscale[pixelIndex - 1]);
          const vertical = Math.abs(
            grayscale[pixelIndex + analysisSize] - grayscale[pixelIndex - analysisSize]
          );
          const gradient = (horizontal + vertical) / 2;
          horizontalEnergy += horizontal;
          verticalEnergy += vertical;
          const laplacian = Math.abs(
            center * 4 -
              grayscale[pixelIndex - 1] -
              grayscale[pixelIndex + 1] -
              grayscale[pixelIndex - analysisSize] -
              grayscale[pixelIndex + analysisSize]
          );
          gradientValues[samples] = gradient;
          laplacianValues[samples] = laplacian;
          gradientSum += gradient;
          laplacianSum += laplacian;
          samples += 1;
        }
      }

      const sampleCount = Math.max(samples, 1);
      const gradientMean = gradientSum / sampleCount;
      const laplacianMean = laplacianSum / sampleCount;
      let gradientVariance = 0;
      let laplacianVariance = 0;
      for (let index = 0; index < samples; index += 1) {
        gradientVariance += (gradientValues[index] - gradientMean) ** 2;
        laplacianVariance += (laplacianValues[index] - laplacianMean) ** 2;
      }
      const gradientDeviation = Math.sqrt(gradientVariance / sampleCount);
      const laplacianDeviation = Math.sqrt(laplacianVariance / sampleCount);
      const gradientThreshold = Math.max(2, gradientMean + gradientDeviation * 0.35);
      const laplacianThreshold = Math.max(2, laplacianMean + laplacianDeviation * 0.35);
      let gradientSpreadCount = 0;
      let laplacianSpreadCount = 0;
      for (let index = 0; index < samples; index += 1) {
        if (gradientValues[index] >= gradientThreshold) gradientSpreadCount += 1;
        if (laplacianValues[index] >= laplacianThreshold) laplacianSpreadCount += 1;
      }
      const gradientSpread = gradientSpreadCount / sampleCount;
      const laplacianSpread = laplacianSpreadCount / sampleCount;
      const textureSpread = (gradientSpread + laplacianSpread) / 2;
      const directionBalance =
        1 -
        Math.abs(horizontalEnergy - verticalEnergy) /
          Math.max(horizontalEnergy + verticalEnergy, 1);
      const detailScore = gradientMean * 0.45 + laplacianMean * 0.55;
      const textureFactor = 0.45 + Math.min(textureSpread * 1.85, 0.55);
      const directionFactor = 0.4 + directionBalance * 0.6;
      const score = detailScore * textureFactor * directionFactor;

      tileScores[tileY * focusGridSize + tileX] = samples > 0 ? score : 0;
    }
  }

  return {
    fingerprint: normalizePhotoFingerprint(fingerprintValues),
    hashBits,
    tileScores,
  };
}

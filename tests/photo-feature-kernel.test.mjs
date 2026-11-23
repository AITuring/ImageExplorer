import assert from "node:assert/strict";
import test from "node:test";
import { computePhotoFeaturesFromRgba } from "../src/lib/photoFeatureKernel.ts";

test("computePhotoFeaturesFromRgba extracts stronger tile sharpness on textured regions than flat regions", () => {
  const size = 128;
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const idx = (y * size + x) * 4;
      // Put a crisp checkerboard texture in the top-left quadrant, flat gray elsewhere.
      const value = x < 64 && y < 64 ? (((x + y) & 1) === 0 ? 230 : 25) : 128;
      rgba[idx] = value;
      rgba[idx + 1] = value;
      rgba[idx + 2] = value;
      rgba[idx + 3] = 255;
    }
  }

  const output = computePhotoFeaturesFromRgba({
    rgba,
    analysisSize: size,
    fingerprintSize: 16,
    hashSize: 8,
    focusGridSize: 6,
    contentLeft: 0,
    contentTop: 0,
    contentWidth: size,
    contentHeight: size,
  });

  assert.equal(output.fingerprint.length, 256);
  assert.equal(output.hashBits.length, 64);
  assert.equal(output.tileScores.length, 36);
  // Tile (0,0) in textured quadrant should score much higher than tile (5,5) in flat quadrant.
  assert.ok(output.tileScores[0] > 40);
  assert.equal(output.tileScores[35], 0);
});

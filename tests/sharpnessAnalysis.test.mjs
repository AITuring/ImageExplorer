import assert from "node:assert/strict";
import test from "node:test";
import { computeSharpnessMask } from "../src/lib/sharpnessAnalysis.ts";

function edgeImage(softness) {
  const width = 128;
  const height = 128;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const value = softness === 0
        ? (x < 64 ? 40 : 220)
        : 40 + 180 / (1 + Math.exp(-(x - 64) / softness));
      pixels[index] = value;
      pixels[index + 1] = value;
      pixels[index + 2] = value;
      pixels[index + 3] = 255;
    }
  }
  return computeSharpnessMask(pixels, width, height);
}

test("high contrast alone does not make a broad soft edge sharp", () => {
  assert.ok(edgeImage(0).highlightedPixels > 0);
  assert.ok(edgeImage(2).highlightedPixels < edgeImage(0).highlightedPixels / 4);
});

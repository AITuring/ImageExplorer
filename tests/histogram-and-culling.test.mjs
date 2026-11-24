import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClippingMaskRgba,
  computeHistogramFromRgba,
} from "../src/lib/histogramAnalysis.ts";
import { computeAutoPickBest } from "../src/lib/autoPickBest.ts";
import { DEFAULT_FOLDER_FILTER, filterFolderEntries } from "../src/lib/folderFilter.ts";
import {
  parseExifCapturedSeconds,
  sortFileEntries,
} from "../src/components/FileList/hooks/finderListModel.ts";

test("computeHistogramFromRgba and buildClippingMaskRgba accurately track highlights and shadows", () => {
  // 4 pixels: pure black (shadow clip), mid gray, pure white (highlight clip), mid green
  const rgba = new Uint8ClampedArray([
    0, 0, 0, 255,
    128, 128, 128, 255,
    255, 255, 255, 255,
    40, 180, 60, 255,
  ]);
  const hist = computeHistogramFromRgba(rgba, 2, 2);
  assert.equal(hist.totalPixels, 4);
  assert.equal(hist.shadowClipRatio, 0.25);
  assert.equal(hist.highlightClipRatio, 0.25);
  assert.equal(hist.r[0], 1);
  assert.equal(hist.r[255], 1);
  assert.equal(hist.g[180], 1);

  const mask = buildClippingMaskRgba(rgba, 2, 2);
  // Pixel 0 -> blue shadow warning
  assert.equal(mask[2], 246);
  assert.ok(mask[3] > 0);
  // Pixel 1 -> transparent
  assert.equal(mask[4 + 3], 0);
  // Pixel 2 -> red highlight warning
  assert.equal(mask[8], 239);
  assert.ok(mask[8 + 3] > 0);
});

test("computeAutoPickBest selects sharpest frame per burst group and rejects duplicates", () => {
  const result = computeAutoPickBest([
    { path: "/shoot/a1.arw", groupId: 1, focusConfidence: 0.4, focusKind: "localized", sharpnessVerdict: "soft" },
    { path: "/shoot/a2.arw", groupId: 1, focusConfidence: 0.85, focusKind: "localized", sharpnessVerdict: "sharp" },
    { path: "/shoot/a3.arw", groupId: 1, focusConfidence: 0.72, focusKind: "localized", sharpnessVerdict: "sharp" },
    { path: "/shoot/solo.arw", groupId: null, focusConfidence: 0.9, focusKind: "localized", sharpnessVerdict: "sharp" },
  ]);
  assert.equal(result.groupCount, 1);
  assert.deepEqual(result.bestPaths, ["/shoot/a2.arw"]);
  assert.deepEqual(result.rejectedPaths, ["/shoot/a1.arw", "/shoot/a3.arw"]);
});

test("filterFolderEntries supports star ratings, pick/reject flags, and camera/lens EXIF filters", () => {
  const entries = [
    { name: "p1.arw", path: "/s/p1.arw", is_dir: false, extension: "arw", tags: [] },
    { name: "p2.arw", path: "/s/p2.arw", is_dir: false, extension: "arw", tags: [] },
    { name: "p3.jpg", path: "/s/p3.jpg", is_dir: false, extension: "jpg", tags: [] },
  ];
  const culling = new Map([
    ["/s/p1.arw", { rating: 5, flag: "pick" }],
    ["/s/p2.arw", { rating: 2, flag: "reject" }],
    ["/s/p3.jpg", { rating: 4, flag: "pick" }],
  ]);
  const meta = new Map([
    ["/s/p1.arw", { model: "ILCE-7M4", lens: "FE 50mm F1.2 GM" }],
    ["/s/p2.arw", { model: "ILCE-7M4", lens: "FE 24-70mm F2.8 GM II" }],
    ["/s/p3.jpg", { model: "X-T5", lens: "XF 35mm F1.4" }],
  ]);

  assert.deepEqual(
    filterFolderEntries(
      entries,
      { ...DEFAULT_FOLDER_FILTER, flag: "pick", minRating: 5 },
      undefined,
      culling,
      (entry) => meta.get(entry.path)
    ).map((e) => e.name),
    ["p1.arw"]
  );

  assert.deepEqual(
    filterFolderEntries(
      entries,
      { ...DEFAULT_FOLDER_FILTER, cameraModel: "ILCE-7M4", lensModel: "FE 24-70mm F2.8 GM II" },
      undefined,
      culling,
      (entry) => meta.get(entry.path)
    ).map((e) => e.name),
    ["p2.arw"]
  );

  // Unflagged filter returns only entries without pick/reject flags
  const withUnflagged = [
    ...entries,
    { name: "p4.jpg", path: "/s/p4.jpg", is_dir: false, extension: "jpg", tags: [] },
  ];
  assert.deepEqual(
    filterFolderEntries(
      withUnflagged,
      { ...DEFAULT_FOLDER_FILTER, flag: "unflagged" },
      undefined,
      culling
    ).map((e) => e.name),
    ["p4.jpg"]
  );
});

test("parseExifCapturedSeconds and sortFileEntries sort photos accurately by EXIF capture time", () => {
  const ts1 = parseExifCapturedSeconds("2025:05:10 08:30:12");
  const ts2 = parseExifCapturedSeconds("2025:05:10 08:30:15");
  assert.ok(ts1 !== null && ts2 !== null && ts2 - ts1 === 3);

  const items = [
    { name: "IMG_2.ARW", path: "/a/IMG_2.ARW", is_dir: false, size: 100, modified: 10, extension: "ARW" },
    { name: "IMG_1.ARW", path: "/a/IMG_1.ARW", is_dir: false, size: 100, modified: 99, extension: "ARW" },
    { name: "IMG_3.ARW", path: "/a/IMG_3.ARW", is_dir: false, size: 100, modified: 50, extension: "ARW" },
  ];
  const captured = new Map([
    ["/a/IMG_1.ARW", "2025:05:10 08:30:10"],
    ["/a/IMG_2.ARW", "2025:05:10 08:30:20"],
    ["/a/IMG_3.ARW", "2025:05:10 08:30:15"],
  ]);
  const sorted = sortFileEntries(items, "captured", "asc", (entry) => captured.get(entry.path));
  assert.deepEqual(
    sorted.map((e) => e.name),
    ["IMG_1.ARW", "IMG_3.ARW", "IMG_2.ARW"]
  );
});

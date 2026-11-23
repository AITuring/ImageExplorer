import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FOLDER_FILTER,
  filterFolderEntries,
} from "../src/lib/folderFilter.ts";
import {
  expandPairedEntries,
  pairRawAndJpegEntries,
} from "../src/lib/rawJpegPairing.ts";

const entries = [
  { name: "DSC0001.ARW", path: "/shoot/DSC0001.ARW", is_dir: false, extension: "ARW", tags: ["Green"] },
  { name: "DSC0001.JPG", path: "/shoot/DSC0001.JPG", is_dir: false, extension: "JPG", tags: ["Green"] },
  { name: "DSC0002.ARW", path: "/shoot/DSC0002.ARW", is_dir: false, extension: "ARW", tags: ["Red"] },
  { name: "solo.jpg", path: "/shoot/solo.jpg", is_dir: false, extension: "jpg", tags: [] },
  { name: "clip.mov", path: "/shoot/clip.mov", is_dir: false, extension: "mov", tags: [] },
  { name: "Selects", path: "/shoot/Selects", is_dir: true, extension: null, tags: [] },
];

test("pairRawAndJpegEntries collapses same-stem RAW+JPG and expands linked operations", () => {
  const paired = pairRawAndJpegEntries(entries);
  assert.equal(paired.pairCount, 1);
  assert.deepEqual(
    paired.entries.map((entry) => entry.name),
    ["DSC0001.ARW", "DSC0002.ARW", "solo.jpg", "clip.mov", "Selects"]
  );
  assert.equal(paired.companionsByPrimaryPath.get("/shoot/DSC0001.ARW")?.[0]?.name, "DSC0001.JPG");

  const expanded = expandPairedEntries([entries[0]], paired.companionsByPrimaryPath);
  assert.deepEqual(
    expanded.map((entry) => entry.name),
    ["DSC0001.ARW", "DSC0001.JPG"]
  );
});

test("filterFolderEntries combines keyword, format, sharpness, and Finder tag filters", () => {
  const sharpness = new Map([
    ["/shoot/DSC0001.ARW", "sharp"],
    ["/shoot/DSC0002.ARW", "soft"],
  ]);

  assert.deepEqual(
    filterFolderEntries(entries, { ...DEFAULT_FOLDER_FILTER, format: "raw" }, sharpness).map(
      (e) => e.name
    ),
    ["DSC0001.ARW", "DSC0002.ARW"]
  );

  assert.deepEqual(
    filterFolderEntries(entries, { ...DEFAULT_FOLDER_FILTER, sharpness: "soft" }, sharpness).map(
      (e) => e.name
    ),
    ["DSC0002.ARW"]
  );

  assert.deepEqual(
    filterFolderEntries(
      entries,
      { ...DEFAULT_FOLDER_FILTER, tagId: "Green", format: "raw" },
      sharpness
    ).map((e) => e.name),
    ["DSC0001.ARW"]
  );
});

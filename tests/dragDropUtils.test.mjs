import test from "node:test";
import assert from "node:assert/strict";
import {
  filterDropPathsForTarget,
  getPathVolumeRoot,
  matchPasteboardPathsToExpectedNames,
  resolveFileDropOperation,
} from "../src/lib/dragDropUtils.ts";

test("getPathVolumeRoot distinguishes macOS external volumes from boot disk", () => {
  assert.equal(getPathVolumeRoot("/Users/test/Desktop/photo.ARW"), "/");
  assert.equal(getPathVolumeRoot("/Volumes/2023.九十/9.24故宫/DSC0001.ARW"), "/Volumes/2023.九十");
  assert.equal(getPathVolumeRoot("/Volumes/2024.345"), "/Volumes/2024.345");
  assert.equal(getPathVolumeRoot("/Volumes/2024.345/"), "/Volumes/2024.345");
});

test("resolveFileDropOperation follows macOS Finder same-volume move and cross-volume copy semantics", () => {
  const srcDriveA = ["/Volumes/2023.九十/9.24故宫/DSC0001.ARW"];
  const destDriveA = "/Volumes/2023.九十/精选";
  const destDriveB = "/Volumes/2024.345";

  // Same volume: move by default, Option copies
  assert.equal(resolveFileDropOperation(srcDriveA, destDriveA, { altKey: false, metaKey: false }), "move");
  assert.equal(resolveFileDropOperation(srcDriveA, destDriveA, { altKey: true, metaKey: false }), "copy");

  // Cross volume: copy by default, Command moves, Option still copies
  assert.equal(resolveFileDropOperation(srcDriveA, destDriveB, { altKey: false, metaKey: false }), "copy");
  assert.equal(resolveFileDropOperation(srcDriveA, destDriveB, { altKey: false, metaKey: true }), "move");
  assert.equal(resolveFileDropOperation(srcDriveA, destDriveB, { altKey: true, metaKey: true }), "copy");
});

test("filterDropPathsForTarget rejects self, ancestor-into-child, and same-parent no-op moves", () => {
  const sources = [
    "/Volumes/2024.345",
    "/Volumes/2024.345/trip/photo.jpg",
    "/Volumes/2023.九十/other.jpg",
  ];

  // Moving into /Volumes/2024.345/trip drops ancestor (/Volumes/2024.345) and already-present photo.jpg
  assert.deepEqual(
    filterDropPathsForTarget(sources, "/Volumes/2024.345/trip", "move"),
    ["/Volumes/2023.九十/other.jpg"]
  );

  // Copying into /Volumes/2024.345/trip still allows duplicating photo.jpg while blocking ancestor
  assert.deepEqual(
    filterDropPathsForTarget(sources, "/Volumes/2024.345/trip", "copy"),
    ["/Volumes/2024.345/trip/photo.jpg", "/Volumes/2023.九十/other.jpg"]
  );
});

test("matchPasteboardPathsToExpectedNames normalizes NFD/NFC and rejects stale pasteboards", () => {
  const nfdName = "故宫_e\u0301.ARW";
  const nfcPath = "/Volumes/2023.九十/故宫_\u00e9.ARW";
  const stalePath = "/Users/test/Desktop/old_drag.jpg";

  assert.deepEqual(matchPasteboardPathsToExpectedNames([nfcPath, stalePath], [nfdName]), [nfcPath]);
  assert.deepEqual(matchPasteboardPathsToExpectedNames([stalePath], [nfdName]), []);
  assert.deepEqual(matchPasteboardPathsToExpectedNames([nfcPath], []), [nfcPath]);
});

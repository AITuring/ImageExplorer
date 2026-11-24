import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExifPatchFromFields,
  formatShutterDisplay,
  hasAnyPatchValue,
  incrementExifDatetime,
  parseGpsCoordinatePair,
} from "../src/lib/exifSyncHelper.ts";

test("parseGpsCoordinatePair handles comma, Chinese comma, spaces, and hemispheres", () => {
  assert.deepEqual(parseGpsCoordinatePair("32.0415, 118.7892"), {
    latitude: 32.0415,
    longitude: 118.7892,
  });
  assert.deepEqual(parseGpsCoordinatePair("31.230416，121.473701"), {
    latitude: 31.230416,
    longitude: 121.473701,
  });
  assert.deepEqual(parseGpsCoordinatePair("33.8688° S, 151.2093° E"), {
    latitude: -33.8688,
    longitude: 151.2093,
  });
  assert.equal(parseGpsCoordinatePair("95.0, 120.0"), null);
  assert.equal(parseGpsCoordinatePair("not coordinates"), null);
});

test("incrementExifDatetime normalizes and shifts across minute/day boundaries", () => {
  assert.equal(
    incrementExifDatetime("2026-11-16T23:59:59", 2),
    "2026:11:17 00:00:01"
  );
  assert.equal(
    incrementExifDatetime("2026/11/16 09:05", 0),
    "2026:11:16 09:05:00"
  );
  assert.equal(incrementExifDatetime("invalid", 1), null);
});

test("formatShutterDisplay renders standard fractional speeds cleanly", () => {
  assert.equal(formatShutterDisplay("0.004"), "1/250");
  assert.equal(formatShutterDisplay("0.008"), "1/125");
  assert.equal(formatShutterDisplay("1/500"), "1/500");
  assert.equal(formatShutterDisplay("2.5"), "2.5s");
});

test("buildExifPatchFromFields respects group toggles and offsets", () => {
  const patch = buildExifPatchFromFields(
    "/photos/edit.jpg",
    {
      make: "SONY",
      model: "ILCE-7RM5",
      lens: "FE 50mm F1.2 GM",
      iso: "400",
      aperture: "1.4",
      shutterSpeed: "1/250",
      focalLength: "50",
      capturedAt: "2026:11:16 21:17:00",
      latitude: 32.0415,
      longitude: 118.7892,
    },
    { time: true, cameraLens: true, exposure: false, gps: true },
    3
  );

  assert.equal(patch.capturedAt, "2026:11:16 21:17:03");
  assert.equal(patch.model, "ILCE-7RM5");
  assert.equal(patch.iso, null);
  assert.equal(patch.aperture, null);
  assert.equal(patch.latitude, 32.0415);
  assert.equal(hasAnyPatchValue(patch), true);
});

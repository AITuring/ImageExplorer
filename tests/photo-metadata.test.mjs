import assert from "node:assert/strict";
import test from "node:test";
import { getPhotoMetadataSummary } from "../src/lib/photoMetadata.ts";

test("camera float metadata is readable without changing fractional exposure values", () => {
  const summary = getPhotoMetadataSummary({
    aperture: "6.300000190736682",
    focalLength: "35.00000001",
    shutterSpeed: "0.008",
    iso: "1250",
  });
  assert.deepEqual(summary.exposure, ["ISO 1250", "f/6.3", "1/125", "35mm"]);
  assert.equal(getPhotoMetadataSummary(null), null);
});

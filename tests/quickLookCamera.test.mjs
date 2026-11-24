import test from "node:test";
import assert from "node:assert/strict";
import {
  centerCameraOnNormalizedPoint,
  clampQuickLookCamera,
  getMinimapViewportRect,
  panCameraBy,
  zoomCameraAtPoint,
} from "../src/lib/quickLookCamera.ts";

test("zoomCameraAtPoint keeps the pixel under the cursor stationary while zooming", () => {
  const viewport = { width: 1200, height: 800 };
  const fit = { width: 1200, height: 800 };
  const start = clampQuickLookCamera({ scale: 1, tx: 0, ty: 0 }, viewport, fit);

  const anchorX = 360;
  const anchorY = 240;
  const zoomed = zoomCameraAtPoint(start, 2.5, anchorX, anchorY, viewport, fit);

  // Image coordinate under cursor before zoom: (360, 240).
  // Screen coordinate of that same image pixel after zoom: tx + 360 * 2.5
  assert.ok(Math.abs(zoomed.tx + 360 * zoomed.scale - anchorX) < 1e-6);
  assert.ok(Math.abs(zoomed.ty + 240 * zoomed.scale - anchorY) < 1e-6);
});

test("clampQuickLookCamera centers smaller dimensions and clamps overflow pan", () => {
  const viewport = { width: 1200, height: 800 };
  const fit = { width: 600, height: 800 };

  // At 1x, width is 600 < 1200 so tx must center at 300.
  const at1x = clampQuickLookCamera({ scale: 1, tx: -50, ty: 40 }, viewport, fit);
  assert.equal(at1x.tx, 300);
  assert.equal(at1x.ty, 0);

  // At 3x, scaled size is 1800x2400; panning far positive/negative must clamp to [-600..0], [-1600..0].
  const clampedNeg = panCameraBy({ scale: 3, tx: 0, ty: 0 }, -9999, -9999, viewport, fit);
  assert.equal(clampedNeg.tx, -600);
  assert.equal(clampedNeg.ty, -1600);

  const clampedPos = panCameraBy({ scale: 3, tx: -300, ty: -300 }, 9999, 9999, viewport, fit);
  assert.equal(clampedPos.tx, 0);
  assert.equal(clampedPos.ty, 0);
});

test("centerCameraOnNormalizedPoint and getMinimapViewportRect align accurately", () => {
  const viewport = { width: 1000, height: 600 };
  const fit = { width: 900, height: 600 };
  const cam = centerCameraOnNormalizedPoint(3, 0.5, 0.5, viewport, fit);

  assert.equal(cam.scale, 3);
  // Center of 2700x1800 image at viewport center (500, 300) => tx = -850, ty = -600
  assert.equal(cam.tx, -850);
  assert.equal(cam.ty, -600);

  const mini = getMinimapViewportRect(cam, viewport, fit, { width: 150, height: 100 });
  assert.ok(Math.abs(mini.width - (1000 / 2700) * 150) < 1e-6);
  assert.ok(Math.abs(mini.height - (600 / 1800) * 100) < 1e-6);
  assert.ok(Math.abs(mini.x - (850 / 2700) * 150) < 1e-6);
  assert.ok(Math.abs(mini.y - (600 / 1800) * 100) < 1e-6);
});

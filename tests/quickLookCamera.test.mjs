import test from "node:test";
import assert from "node:assert/strict";
import {
  centerCameraOnNormalizedPoint,
  clampQuickLookCamera,
  getCrispCanvasBlitRect,
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

test("getCrispCanvasBlitRect maps full 7008x4672 native pixels onto Retina canvas when zoomed", () => {
  const viewport = { width: 1200, height: 800 };
  const fit = { width: 1200, height: 800 };
  const natural = { width: 7008, height: 4672 };

  // At 1x fit with 2x Retina DPR: entire native image maps onto 2400x1600 physical pixels
  const at1x = getCrispCanvasBlitRect({ scale: 1, tx: 0, ty: 0 }, viewport, fit, natural, 2);
  assert.ok(at1x);
  assert.equal(at1x.srcX, 0);
  assert.equal(at1x.srcY, 0);
  assert.equal(at1x.srcW, 7008);
  assert.equal(at1x.srcH, 4672);
  assert.equal(at1x.dstX, 0);
  assert.equal(at1x.dstY, 0);
  assert.equal(at1x.dstW, 2400);
  assert.equal(at1x.dstH, 1600);

  // At 2.5x centered zoom: visible source crop is 1/2.5 of 7008x4672 centered, mapped 1:1 to 2400x1600
  const centered = centerCameraOnNormalizedPoint(2.5, 0.5, 0.5, viewport, fit);
  const atZoom = getCrispCanvasBlitRect(centered, viewport, fit, natural, 2);
  assert.ok(atZoom);
  assert.ok(Math.abs(atZoom.srcW - 7008 / 2.5) < 1e-6);
  assert.ok(Math.abs(atZoom.srcH - 4672 / 2.5) < 1e-6);
  assert.ok(Math.abs(atZoom.srcX - (7008 - 7008 / 2.5) / 2) < 1e-6);
  assert.ok(Math.abs(atZoom.srcY - (4672 - 4672 / 2.5) / 2) < 1e-6);
  assert.equal(atZoom.dstX, 0);
  assert.equal(atZoom.dstY, 0);
  assert.equal(atZoom.dstW, 2400);
  assert.equal(atZoom.dstH, 1600);

  // Invalid dimensions return null
  assert.equal(
    getCrispCanvasBlitRect({ scale: 1, tx: 0, ty: 0 }, { width: 0, height: 800 }, fit, natural, 2),
    null
  );
});

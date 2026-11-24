export interface QuickLookCamera {
  scale: number;
  tx: number;
  ty: number;
}

export interface Size2D {
  width: number;
  height: number;
}

export const QUICK_LOOK_MIN_ZOOM = 1;
export const QUICK_LOOK_MAX_ZOOM = 6;

export function clampQuickLookZoom(scale: number): number {
  if (!Number.isFinite(scale)) return QUICK_LOOK_MIN_ZOOM;
  return Math.min(QUICK_LOOK_MAX_ZOOM, Math.max(QUICK_LOOK_MIN_ZOOM, scale));
}

/**
 * Clamp `(scale, tx, ty)` so the transformed photo (`fitSize * scale`) always
 * stays centered when smaller than `viewportSize` and never exposes empty gaps
 * past its edges when larger than `viewportSize`.
 */
export function clampQuickLookCamera(
  camera: QuickLookCamera,
  viewportSize: Size2D,
  fitSize: Size2D
): QuickLookCamera {
  const scale = clampQuickLookZoom(camera.scale);
  const scaledWidth = fitSize.width * scale;
  const scaledHeight = fitSize.height * scale;

  const tx =
    scaledWidth <= viewportSize.width
      ? (viewportSize.width - scaledWidth) / 2
      : Math.min(0, Math.max(viewportSize.width - scaledWidth, camera.tx));

  const ty =
    scaledHeight <= viewportSize.height
      ? (viewportSize.height - scaledHeight) / 2
      : Math.min(0, Math.max(viewportSize.height - scaledHeight, camera.ty));

  return { scale, tx, ty };
}

/**
 * Zoom to `targetScale` while keeping the exact image pixel under viewport
 * coordinate `(anchorX, anchorY)` stationary on screen.
 */
export function zoomCameraAtPoint(
  current: QuickLookCamera,
  targetScale: number,
  anchorX: number,
  anchorY: number,
  viewportSize: Size2D,
  fitSize: Size2D
): QuickLookCamera {
  const nextScale = clampQuickLookZoom(targetScale);
  const safeCurrentScale = Math.max(QUICK_LOOK_MIN_ZOOM, current.scale);
  const imageX = (anchorX - current.tx) / safeCurrentScale;
  const imageY = (anchorY - current.ty) / safeCurrentScale;
  return clampQuickLookCamera(
    {
      scale: nextScale,
      tx: anchorX - imageX * nextScale,
      ty: anchorY - imageY * nextScale,
    },
    viewportSize,
    fitSize
  );
}

/** Pan the camera by `(dx, dy)` screen pixels and clamp cleanly to bounds. */
export function panCameraBy(
  current: QuickLookCamera,
  dx: number,
  dy: number,
  viewportSize: Size2D,
  fitSize: Size2D
): QuickLookCamera {
  return clampQuickLookCamera(
    {
      scale: current.scale,
      tx: current.tx + dx,
      ty: current.ty + dy,
    },
    viewportSize,
    fitSize
  );
}

/** Center normalized image point `(normX, normY)` (`0..1`) in the viewport at `targetScale`. */
export function centerCameraOnNormalizedPoint(
  targetScale: number,
  normX: number,
  normY: number,
  viewportSize: Size2D,
  fitSize: Size2D
): QuickLookCamera {
  const scale = clampQuickLookZoom(targetScale);
  const clampedX = Math.min(1, Math.max(0, normX));
  const clampedY = Math.min(1, Math.max(0, normY));
  return clampQuickLookCamera(
    {
      scale,
      tx: viewportSize.width / 2 - clampedX * fitSize.width * scale,
      ty: viewportSize.height / 2 - clampedY * fitSize.height * scale,
    },
    viewportSize,
    fitSize
  );
}

/** Compute the visible viewport rectangle in minimap pixel coordinates. */
export function getMinimapViewportRect(
  camera: QuickLookCamera,
  viewportSize: Size2D,
  fitSize: Size2D,
  minimapSize: Size2D
): { x: number; y: number; width: number; height: number } {
  const scaledWidth = Math.max(1, fitSize.width * camera.scale);
  const scaledHeight = Math.max(1, fitSize.height * camera.scale);
  const visLeft = Math.max(0, -camera.tx) / scaledWidth;
  const visTop = Math.max(0, -camera.ty) / scaledHeight;
  const visWidth = Math.min(1, viewportSize.width / scaledWidth);
  const visHeight = Math.min(1, viewportSize.height / scaledHeight);
  return {
    x: visLeft * minimapSize.width,
    y: visTop * minimapSize.height,
    width: Math.max(8, visWidth * minimapSize.width),
    height: Math.max(8, visHeight * minimapSize.height),
  };
}

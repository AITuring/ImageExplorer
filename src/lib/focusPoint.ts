import type { FocusPoint } from "@/lib/photoAnalysis";

export interface FocusPointPosition {
  left: number;
  top: number;
}

export function getContainedFocusPointPosition({
  point,
  containerWidth,
  containerHeight,
  imageWidth,
  imageHeight,
}: {
  point: FocusPoint;
  containerWidth: number;
  containerHeight: number;
  imageWidth: number;
  imageHeight: number;
}): FocusPointPosition {
  const scale = Math.min(containerWidth / imageWidth, containerHeight / imageHeight);
  const displayedWidth = imageWidth * scale;
  const displayedHeight = imageHeight * scale;
  const offsetX = (containerWidth - displayedWidth) / 2;
  const offsetY = (containerHeight - displayedHeight) / 2;

  return {
    left: ((offsetX + point.x * displayedWidth) / containerWidth) * 100,
    top: ((offsetY + point.y * displayedHeight) / containerHeight) * 100,
  };
}

import type { FocusRegion } from "@/lib/photoAnalysis";

export interface FocusRegionPosition {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function getContainedFocusRegionPosition({
  region,
  containerWidth,
  containerHeight,
  imageWidth,
  imageHeight,
}: {
  region: FocusRegion;
  containerWidth: number;
  containerHeight: number;
  imageWidth: number;
  imageHeight: number;
}): FocusRegionPosition {
  const scale = Math.min(containerWidth / imageWidth, containerHeight / imageHeight);
  const displayedWidth = imageWidth * scale;
  const displayedHeight = imageHeight * scale;
  const offsetX = (containerWidth - displayedWidth) / 2;
  const offsetY = (containerHeight - displayedHeight) / 2;

  return {
    left: ((offsetX + region.x * displayedWidth) / containerWidth) * 100,
    top: ((offsetY + region.y * displayedHeight) / containerHeight) * 100,
    width: ((region.width * displayedWidth) / containerWidth) * 100,
    height: ((region.height * displayedHeight) / containerHeight) * 100,
  };
}

import { computePhotoFeaturesFromRgba } from "@/lib/photoFeatureKernel";

export interface PhotoFeatureWorkerRequest {
  id: number;
  rgbaBuffer: ArrayBuffer;
  analysisSize: number;
  fingerprintSize: number;
  hashSize: number;
  focusGridSize: number;
  contentLeft: number;
  contentTop: number;
  contentWidth: number;
  contentHeight: number;
}

export interface PhotoFeatureWorkerResponse {
  id: number;
  fingerprintBuffer: ArrayBuffer;
  hashBitsBuffer: ArrayBuffer;
  tileScoresBuffer: ArrayBuffer;
}

interface FeatureWorkerScope {
  onmessage: ((event: MessageEvent<PhotoFeatureWorkerRequest>) => void) | null;
  postMessage: (message: PhotoFeatureWorkerResponse, transfer: Transferable[]) => void;
}

const workerScope = self as unknown as FeatureWorkerScope;

workerScope.onmessage = (event: MessageEvent<PhotoFeatureWorkerRequest>) => {
  const {
    id,
    rgbaBuffer,
    analysisSize,
    fingerprintSize,
    hashSize,
    focusGridSize,
    contentLeft,
    contentTop,
    contentWidth,
    contentHeight,
  } = event.data;

  const result = computePhotoFeaturesFromRgba({
    rgba: new Uint8ClampedArray(rgbaBuffer),
    analysisSize,
    fingerprintSize,
    hashSize,
    focusGridSize,
    contentLeft,
    contentTop,
    contentWidth,
    contentHeight,
  });

  const fingerprintBuffer = result.fingerprint.buffer as ArrayBuffer;
  const hashBitsBuffer = result.hashBits.buffer as ArrayBuffer;
  const tileScoresBuffer = result.tileScores.buffer as ArrayBuffer;

  const response: PhotoFeatureWorkerResponse = {
    id,
    fingerprintBuffer,
    hashBitsBuffer,
    tileScoresBuffer,
  };
  workerScope.postMessage(response, [fingerprintBuffer, hashBitsBuffer, tileScoresBuffer]);
};

import { computeSharpnessMask } from "../lib/sharpnessAnalysis";

interface SharpnessWorkerRequest {
  pixels: ArrayBuffer;
  width: number;
  height: number;
}

interface SharpnessWorkerScope {
  onmessage: ((event: MessageEvent<SharpnessWorkerRequest>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

const workerScope = self as unknown as SharpnessWorkerScope;

workerScope.onmessage = (event) => {
  try {
    const { pixels, width, height } = event.data;
    const result = computeSharpnessMask(new Uint8ClampedArray(pixels), width, height);
    const rgba = result.rgba.buffer as ArrayBuffer;
    workerScope.postMessage(
      {
        ok: true,
        width: result.width,
        height: result.height,
        rgba,
        highlightedPixels: result.highlightedPixels,
        highlightedRatio: result.highlightedRatio,
      },
      [rgba]
    );
  } catch (error) {
    workerScope.postMessage(
      {
        ok: false,
        message: error instanceof Error ? error.message : "Sharpness worker failed",
      },
      []
    );
  }
};

export {};

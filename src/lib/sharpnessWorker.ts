import { computeSharpnessMask, type SharpnessMaskResult } from "@/lib/sharpnessAnalysis";

interface SharpnessWorkerSuccess {
  ok: true;
  width: number;
  height: number;
  rgba: ArrayBuffer;
  highlightedPixels: number;
  highlightedRatio: number;
}

interface SharpnessWorkerFailure {
  ok: false;
  message: string;
}

type SharpnessWorkerResponse = SharpnessWorkerSuccess | SharpnessWorkerFailure;

function abortError() {
  return new DOMException("Sharpness analysis was cancelled", "AbortError");
}

/**
 * Runs the CPU-heavy focus-peaking pass outside React's UI thread. A fresh
 * worker keeps cancellation deterministic: terminating it immediately drops
 * stale work when the preview changes or closes.
 */
export function computeSharpnessMaskOffThread(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  signal: AbortSignal
): Promise<SharpnessMaskResult> {
  if (signal.aborted) return Promise.reject(abortError());

  if (typeof Worker === "undefined") {
    return Promise.resolve(computeSharpnessMask(pixels, width, height));
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../workers/sharpnessAnalysis.worker.ts", import.meta.url), {
      type: "module",
      name: "sharpness-analysis",
    });
    let settled = false;

    const cleanup = () => {
      signal.removeEventListener("abort", handleAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const handleAbort = () => finish(() => reject(abortError()));

    worker.onmessage = (event: MessageEvent<SharpnessWorkerResponse>) => {
      const response = event.data;
      if (!response.ok) {
        finish(() => reject(new Error(response.message)));
        return;
      }

      finish(() =>
        resolve({
          width: response.width,
          height: response.height,
          rgba: new Uint8ClampedArray(response.rgba),
          highlightedPixels: response.highlightedPixels,
          highlightedRatio: response.highlightedRatio,
        })
      );
    };
    worker.onerror = (event) => {
      finish(() => reject(new Error(event.message || "Sharpness worker failed")));
    };
    signal.addEventListener("abort", handleAbort, { once: true });

    const pixelBuffer = pixels.buffer as ArrayBuffer;
    try {
      worker.postMessage({ pixels: pixelBuffer, width, height }, [pixelBuffer]);
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error("Sharpness worker failed")));
    }
  });
}

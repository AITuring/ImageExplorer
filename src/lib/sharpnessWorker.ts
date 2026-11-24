import type { SharpnessMaskResult } from "@/lib/sharpnessAnalysis";

interface SharpnessWorkerSuccess {
  ok: true;
  width: number;
  height: number;
  rgba: ArrayBuffer | null;
  highlightedPixels: number;
  highlightedRatio: number;
}

interface SharpnessWorkerFailure {
  ok: false;
  message: string;
}

type SharpnessWorkerResponse = SharpnessWorkerSuccess | SharpnessWorkerFailure;

const MAX_IDLE_WORKERS = 3;
const idleWorkers: Worker[] = [];

function acquireWorker(): Worker {
  return (
    idleWorkers.pop() ??
    new Worker(new URL("../workers/sharpnessAnalysis.worker.ts", import.meta.url), {
      type: "module",
      name: "sharpness-analysis",
    })
  );
}

function releaseWorker(worker: Worker, reusable: boolean) {
  worker.onmessage = null;
  worker.onerror = null;
  if (reusable && idleWorkers.length < MAX_IDLE_WORKERS) {
    idleWorkers.push(worker);
  } else {
    worker.terminate();
  }
}

function abortError() {
  return new DOMException("Sharpness analysis was cancelled", "AbortError");
}

function runSharpnessWorker(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  signal: AbortSignal,
  verdictOnly: boolean
): Promise<SharpnessMaskResult> {
  if (signal.aborted) return Promise.reject(abortError());

  if (typeof Worker === "undefined") {
    return Promise.reject(new Error("Sharpness analysis requires a background worker"));
  }

  return new Promise((resolve, reject) => {
    const worker = acquireWorker();
    let settled = false;

    const cleanup = (reusable: boolean) => {
      signal.removeEventListener("abort", handleAbort);
      releaseWorker(worker, reusable);
    };
    const finish = (reusable: boolean, callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup(reusable);
      callback();
    };
    const handleAbort = () => finish(false, () => reject(abortError()));

    worker.onmessage = (event: MessageEvent<SharpnessWorkerResponse>) => {
      const response = event.data;
      if (!response.ok) {
        finish(true, () => reject(new Error(response.message)));
        return;
      }

      finish(true, () =>
        resolve({
          width: response.width,
          height: response.height,
          rgba: response.rgba ? new Uint8ClampedArray(response.rgba) : new Uint8ClampedArray(0),
          highlightedPixels: response.highlightedPixels,
          highlightedRatio: response.highlightedRatio,
        })
      );
    };
    worker.onerror = (event) => {
      finish(false, () => reject(new Error(event.message || "Sharpness worker failed")));
    };
    signal.addEventListener("abort", handleAbort, { once: true });

    const pixelBuffer = pixels.buffer as ArrayBuffer;
    try {
      worker.postMessage({ pixels: pixelBuffer, width, height, verdictOnly }, [pixelBuffer]);
    } catch (error) {
      finish(false, () =>
        reject(error instanceof Error ? error : new Error("Sharpness worker failed"))
      );
    }
  });
}

/**
 * Runs the CPU-heavy focus-peaking pass outside React's UI thread. Idle workers
 * are pooled so folder scans avoid per-photo module worker startup overhead,
 * while an aborted in-flight worker is still terminated immediately.
 */
export function computeSharpnessMaskOffThread(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  signal: AbortSignal
): Promise<SharpnessMaskResult> {
  return runSharpnessWorker(pixels, width, height, signal, false);
}

/** Lightweight variant for folder scanning that skips allocating/transferring the RGBA mask. */
export async function computeSharpnessVerdictOffThread(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  signal: AbortSignal
): Promise<boolean> {
  const result = await runSharpnessWorker(pixels, width, height, signal, true);
  return result.highlightedPixels > 0;
}

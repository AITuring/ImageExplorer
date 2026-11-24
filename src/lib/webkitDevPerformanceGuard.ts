// In development mode, React 19 DevTools Performance Tracks call
// `performance.measure("\u200b...", { detail: { devtools: { properties } } })`
// on component renders. macOS WebKit implements `performance.measure` `detail`
// via synchronous `structuredClone` (`SerializedScriptValue::create`) and retains
// entries indefinitely, freezing the WebContent main thread at 100% CPU and
// consuming gigabytes of RAM whenever components receive large folder or photo
// analysis props.
if (
  import.meta.env.DEV &&
  typeof performance !== "undefined" &&
  typeof performance.measure === "function"
) {
  const originalMeasure = performance.measure.bind(performance);
  performance.measure = function guardedMeasure(
    measureName: string,
    startOrMeasureOptions?: string | PerformanceMeasureOptions,
    endMark?: string
  ): PerformanceMeasure {
    const isReactDevTrack =
      measureName.startsWith("\u200b") ||
      (typeof startOrMeasureOptions === "object" &&
        startOrMeasureOptions !== null &&
        "detail" in startOrMeasureOptions &&
        typeof startOrMeasureOptions.detail === "object" &&
        startOrMeasureOptions.detail !== null &&
        "devtools" in startOrMeasureOptions.detail);
    if (isReactDevTrack) {
      return undefined as unknown as PerformanceMeasure;
    }
    return originalMeasure(measureName, startOrMeasureOptions as string, endMark);
  } as typeof performance.measure;
}

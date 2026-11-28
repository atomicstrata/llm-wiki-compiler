/**
 * @file test/scale-measure/sampler.ts
 * @description The heap and RSS SAMPLER of a measurement child: it samples
 * `process.memoryUsage()` every few milliseconds until stopped and returns
 * the high-water marks it saw. A sampled high-water is an OBSERVATION (it can
 * miss a peak between samples), not a bound; the child also reports the
 * kernel's `maxRSS` for the whole process.
 */

/** Milliseconds between heap and RSS samples. */
const SAMPLE_MS = 5;

/** Sample heap and RSS until stopped; returns the high-water marks. */
export function startSampler(): () => { peakHeapUsedBytes: number; peakRssBytes: number } {
  let peakHeapUsedBytes = 0;
  let peakRssBytes = 0;
  const sample = () => {
    const usage = process.memoryUsage();
    peakHeapUsedBytes = Math.max(peakHeapUsedBytes, usage.heapUsed);
    peakRssBytes = Math.max(peakRssBytes, usage.rss);
  };
  const timer = setInterval(sample, SAMPLE_MS);
  return () => { clearInterval(timer); sample(); return { peakHeapUsedBytes, peakRssBytes }; };
}

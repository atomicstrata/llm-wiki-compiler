/**
 * Shared test probe for compile-path concurrency.
 *
 * Spies AnthropicProvider.toolCall so each extraction briefly overlaps (a 25ms
 * sleep) while tracking how many extractions are in flight at once. Used by the
 * compile and refresh concurrency tests to assert the cap is honoured without
 * duplicating the in-flight bookkeeping. The caller stubs `complete` separately
 * and restores mocks in afterEach.
 */

import { vi } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic.js";

/** Per-extraction sleep so concurrent calls measurably overlap. */
const OVERLAP_MS = 25;

/**
 * Install the toolCall probe.
 * @param makeResult - Returns the extraction JSON for the n-th (0-based) call.
 * @returns A getter for the peak number of simultaneous extractions observed.
 */
export function trackToolCallConcurrency(makeResult: (n: number) => string): () => number {
  let inFlight = 0;
  let peak = 0;
  let n = 0;
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockImplementation(async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, OVERLAP_MS));
    inFlight--;
    return makeResult(n++);
  });
  return () => peak;
}

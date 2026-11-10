/**
 * @file test/wait-for.ts
 * @description Retry an assertion until it passes or a deadline lapses.
 *
 * Bun's test runner has no `waitFor`. Suites use this to observe work another
 * async path finishes "soon" (a broker dispatch, a DOM render) without sleeping
 * a fixed time: the last assertion error is rethrown so a timeout still reports
 * what was actually observed.
 */

const DEFAULT_TIMEOUT_MS = 1_000;
const POLL_INTERVAL_MS = 10;

/** Resolve once `assertion` stops throwing; rethrow its last error after `timeout` ms. */
export async function waitFor<T>(assertion: () => T | Promise<T>, options: { timeout?: number } = {}): Promise<T> {
  const deadline = Date.now() + (options.timeout ?? DEFAULT_TIMEOUT_MS);
  for (;;) {
    try {
      return await assertion();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}

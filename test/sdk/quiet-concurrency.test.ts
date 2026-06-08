/**
 * Regression test for concurrent SDK quiet-scoping via AsyncLocalStorage.
 *
 * Exercises the contract that two overlapping `withQuiet(async () => ...)`
 * calls (simulated with timers) never corrupt the global quiet flag and
 * each sees `isQuiet() === true` for the duration of its own run.
 */

import { describe, it, expect } from "vitest";
import { withQuiet, isQuiet, getQuiet } from "../../src/utils/output.js";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("withQuiet concurrent isolation", () => {
  it("concurrent scoped-quiet calls never corrupt the global flag", async () => {
    const seen: boolean[] = [];

    await Promise.all([
      withQuiet(async () => {
        await delay(10);
        seen.push(isQuiet());
      }),
      withQuiet(async () => {
        await delay(30);
        seen.push(isQuiet());
      }),
    ]);

    // Both calls must have seen quiet === true during their own run
    expect(seen).toEqual([true, true]);
    // The global flag must not be stuck-on after both finish
    expect(getQuiet()).toBe(false);
    // No ALS scope is active after all calls complete
    expect(isQuiet()).toBe(false);
  });

  it("isQuiet propagates across nested awaits inside withQuiet", async () => {
    async function deeplyNested(): Promise<boolean> {
      await delay(1);
      await delay(1);
      return isQuiet();
    }

    const result = await withQuiet(() => deeplyNested());
    expect(result).toBe(true);
    expect(isQuiet()).toBe(false);
  });
});

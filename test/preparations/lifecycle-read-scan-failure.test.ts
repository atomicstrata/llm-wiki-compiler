/**
 * @file test/preparations/lifecycle-read-scan-failure.test.ts
 * @description Deterministic production-boundary proof that a scanner-leg
 * failure becomes one bounded unavailable lifecycle read without recapture.
 */

import { describe, expect, it, vi } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";

const scanAttempt = vi.hoisted(() => vi.fn(async () => {
  throw new Error("forced scanner failure with sensitive detail");
}));

vi.mock("../../src/preparations/lifecycle-snapshot/scan.js", () => ({
  scanPreparationLifecycle: scanAttempt,
}));

import {
  withPreparationLifecycleRead,
} from "../../src/preparations/lifecycle-snapshot/read.js";

describe("leased lifecycle scanner failure", () => {
  const root = useTempRoot();

  it("returns one bounded unavailable read without retry or recapture", async () => {
    let callbackCalls = 0;
    const retained = await withPreparationLifecycleRead(root.dir, (read) => {
      callbackCalls += 1;
      return read;
    });
    expect(scanAttempt).toHaveBeenCalledTimes(1);
    expect(callbackCalls).toBe(1);
    expect(retained).toEqual({
      status: "unavailable",
      detail: "preparation lifecycle capture is unavailable",
    });
  });
});

/** Disposable enforcement witness; this test must never be merged into main. */
import { expect, it } from "vitest";

it("isolates test type checking from runtime checking", () => {
  const typedNumber: number = 1;
  expect(typedNumber).toBe(1);
});

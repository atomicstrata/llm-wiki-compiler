/** Disposable enforcement witness; this test must never be merged into main. */
import { expect, it } from "vitest";

it("isolates test type checking from runtime checking", () => {
  const typedNumber: number = "intentional-type-error";
  expect(typedNumber).toBe("intentional-type-error");
});

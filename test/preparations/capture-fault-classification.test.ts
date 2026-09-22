/**
 * @file test/preparations/capture-fault-classification.test.ts
 * @description A capture boundary distinguishes "does not qualify" from "went
 * wrong", and both halves are asserted.
 *
 * A BARE CATCH COLLAPSES OPPOSITE ANSWERS. "This value does not qualify" is a
 * statement about the caller's input; "something failed while reading it" is
 * not. Reporting the second as the first tells a caller its input is invalid
 * when nothing established that — the same shape as reading EPERM as "the
 * process is gone".
 *
 * BOTH DIRECTIONS ARE REQUIRED, and the second is what stops this passing
 * vacuously: a helper that rethrew EVERYTHING would satisfy the escape case
 * alone. So the ordinary refusal is pinned beside it.
 */

import { describe, expect, it } from "vitest";
import { RuntimeCaptureError, capturedOr, tryCaptureOwnDataRecord } from "../../src/utils/runtime-capture.js";

/** A fault that is emphatically not the capture's own refusal. */
class UnexpectedFault extends Error {
  constructor() {
    super("the primitive itself failed");
    this.name = "UnexpectedFault";
  }
}

describe("capturedOr classifies refusal against fault", () => {
  it("propagates an error that is NOT the capture's own refusal", () => {
    // WELL-FORMED IN EVERY RESPECT EXCEPT THE THING UNDER TEST: a capture that
    // simply throws the wrong class. The refusal path is otherwise identical,
    // so nothing but the classification can decide the outcome.
    expect(() => capturedOr(() => { throw new UnexpectedFault(); }, () => null))
      .toThrow(UnexpectedFault);
  });

  it("still converts the capture's own refusal into the caller's expression", () => {
    // THE ANTI-VACUITY HALF. Without it, a helper that rethrew everything —
    // which is exactly the over-correction — would pass the case above.
    expect(capturedOr(() => { throw new RuntimeCaptureError(); }, () => null)).toBeNull();
  });

  it("lets each boundary keep its OWN failure expression", () => {
    // The rule is shared; the vocabulary is not. A helper per expression would
    // be four copies of one rule, which is the situation being removed.
    class DomainRefusal extends Error {}
    expect(capturedOr(() => { throw new RuntimeCaptureError(); }, () => "unavailable")).toBe("unavailable");
    expect(() => capturedOr(() => { throw new RuntimeCaptureError(); }, () => { throw new DomainRefusal(); }))
      .toThrow(DomainRefusal);
  });

  it("returns the captured value untouched when nothing throws", () => {
    expect(capturedOr(() => ({ ok: 1 }), () => null)).toEqual({ ok: 1 });
  });

  it("keeps tryCaptureOwnDataRecord's behaviour after being expressed through it", () => {
    // The narrow primitive #82 added is now defined in terms of the shared rule,
    // so its two answers are re-pinned here rather than assumed to have survived.
    expect(tryCaptureOwnDataRecord({ a: 1 })).toEqual({ a: 1 });
    const accessor = {};
    Object.defineProperty(accessor, "x", { get: () => 1, enumerable: true });
    expect(tryCaptureOwnDataRecord(accessor)).toBeNull();
  });
});

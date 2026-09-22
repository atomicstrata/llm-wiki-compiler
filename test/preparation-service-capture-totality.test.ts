/**
 * @file test/preparation-service-capture-totality.test.ts
 * @description The outer-request capture is TOTAL over the service's operations.
 *
 * WHY THIS EXISTS, AND IT IS NOT ABOUT ANY ONE OPERATION. The capture defect was
 * closed across the six operations that existed when it was found. That was a
 * point-in-time sweep with nothing keeping it total, and the very next slice
 * added a seventh — on the DESTRUCTIVE surface — which landed without the
 * capture and no control noticed. An invariant with no enforcement is the
 * defect; the missing operation is only its first instance.
 *
 * THE OPERATION SET IS DERIVED FROM THE SERVICE'S OWN CLOSURE MAP, never
 * hand-listed beside it, so an operation is in scope the moment it exists rather
 * than when somebody remembers to add it here.
 *
 * ARITY IS NOT IN THE ENUMERATION, and that is the whole design. The obvious
 * shape — probe the operations whose closure declares a parameter — makes
 * `Function.length` decide who is IN SCOPE, and it is only a proxy for "takes a
 * request". It disagrees in both directions, and one direction is dangerous: an
 * operation written `async (...args) =>` or `async (request = {}) =>` reports
 * arity 0 and would EXEMPT ITSELF from the control. Measured, not argued — that
 * shape is a mutant below.
 *
 * So the primary case probes EVERY operation the composition exposes and asserts
 * the invariant that actually matters: **no operation invokes a caller accessor,
 * whatever its signature looks like.** An operation that takes no request reads
 * nothing and passes trivially; one that takes a request passes only if it
 * captured by descriptor. Nothing has to be classified for that to hold, so
 * nothing can be misclassified out of scope.
 *
 * The DECLARED map below is still here and is still HAND-WRITTEN. It is not the
 * enumeration — it carries the secondary assertion (a request-taking operation
 * must answer with the capture refusal, not merely read nothing) and it is the
 * compile-time forcing function: keyed on `keyof PreparationServiceV1`, so a new
 * method fails to BUILD until someone states which it is. Arity is kept only as
 * an independent cross-check that the hand-written classification has not
 * drifted from how the closure is actually written — never as the authority.
 */

import { describe, expect, it } from "vitest";
import { createPreparationService } from "../src/preparations/service.js";
import type { PreparationPrincipal, PreparationServiceV1 } from "../src/preparations/service.js";
import { REQUEST_CAPTURE_REFUSAL } from "../src/preparations/service-request-capture.js";
import { emptyWorkspace } from "./preparation-cli-fixture.js";
import { accessorRequest } from "./fixtures/accessor-request.js";

/** Every grant any operation charges, so no case is refused for authority. */
const PRINCIPAL = {
  id: "capture-totality",
  surface: "sdk",
  grants: [
    "preparation.run", "preparation.cancel", "preparation.recovery",
    "preparation.gate.decide", "preparation.quarantine",
  ],
} as unknown as PreparationPrincipal;

/**
 * Whether each operation accepts a caller REQUEST OBJECT.
 *
 * Keyed on `keyof PreparationServiceV1`, so a new operation breaks the build
 * here until someone states which it is. `"none"` is an exemption that has to be
 * CLAIMED — an operation cannot drift out of scope by being forgotten.
 */
const DECLARED_REQUEST_SHAPE: Readonly<Record<keyof PreparationServiceV1, "request" | "none">> = {
  stage: "request",
  list: "none",
  fail: "request",
  cancel: "request",
  recovery: "request",
  gate: "request",
  handoff: "request",
  prune: "request",
  // NO REQUEST AT ALL, and that is the design rather than an oversight: a sweep
  // target is derived under the lock, and the gate REFUSES a caller-supplied one
  // outright rather than discarding it. A silently ignored field would let a
  // future caller believe it was aiming a destructive operation.
  sweep: "none",
  // #86's read family. `preview` was ALREADY routed and that was established by
  // measurement rather than by its silence: it delegates to the same
  // `loadStageDocuments` that `stage` uses, which captures before the first
  // await. Preview no longer shares `stage`'s acquisition — that leg mutated —
  // but it still shares this one, which is the leg the capture lives in.
  //
  // `pause` ARRIVES ROUTED, and it is the member this control was not written
  // against: it is the FIRST PRODUCTION WRITER of `paused`, and it read the
  // caller's request with a plain `[[Get]]` — an own accessor executing in the
  // prologue of a write path. The routing fix is folded into the commit that
  // introduces the operation rather than following it, so no commit in this
  // branch ships an unrouted writer.
  preview: "request",
  pause: "request",
  // ROUTED FROM ITS FIRST COMMIT, because it arrives in the same one as `pause`
  // and inherits the reason: a write path whose run id is read by a plain
  // `[[Get]]` can be retargeted at a run the caller never named, and this one
  // moves a run out of a state only it can move it out of.
  resume: "request",
  show: "request",
  // THE CLI-ONLY REPAIR VERB, and its classification is the one that had to be
  // reasoned about rather than copied. This control builds its service on the
  // `sdk` surface, where `reset` refuses by surface — so for the probe to reach
  // the capture at all, the capture must run BEFORE that refusal. It does, and
  // deliberately: capturing grants nothing and touches nothing, while refusing
  // first would make this the one operation whose request is never read by
  // descriptor. Its request is also the only NESTED one here besides handoff's,
  // so a second capture guards `continuation` one level in.
  reset: "request",
};

/**
 * A superset of every field any operation reads off its request.
 *
 * Deliberately a superset rather than per-operation: an operation that reads a
 * field nobody expected still gets an accessor for it, and an unexpected key is
 * refused by the capture rather than silently ignored.
 */
const PROBE_FIELDS = {
  runId: "prr_" + "a".repeat(32),
  gateId: "review",
  decision: "approved",
  reasonCode: "why",
  obligations: {},
  documents: {},
  controlTransitionAllowance: 1,
};

/** The service under test, over a throwaway project. */
async function serviceOver(suffix: string): Promise<PreparationServiceV1> {
  const cwd = await emptyWorkspace(`capture-totality-${suffix}`);
  return createPreparationService({
    root: cwd, surface: "sdk", principals: { principalFor: () => PRINCIPAL },
  });
}

describe("the outer-request capture is total over the service", () => {
  it("classifies exactly the operations the service actually exposes", async () => {
    const service = await serviceOver("keys");
    // DERIVED FROM THE CLOSURE MAP, compared against the declared classification.
    expect(Object.keys(service).sort()).toEqual(Object.keys(DECLARED_REQUEST_SHAPE).sort());
  });

  it("agrees with the arity the composition actually built", async () => {
    const service = await serviceOver("arity");
    const derived = Object.fromEntries(Object.entries(service).map(
      ([name, fn]) => [name, (fn as (...args: unknown[]) => unknown).length > 0 ? "request" : "none"],
    ));
    expect(derived).toEqual(DECLARED_REQUEST_SHAPE);
  });

  it("invokes no caller accessor on ANY request-taking operation", async () => {
    const service = await serviceOver("accessors");
    const offenders: string[] = [];
    // EVERY OPERATION, WITH NO FILTER. Two earlier revisions each narrowed this
    // loop and each left a hole. Iterating the DECLARED map meant an operation
    // nobody had classified was never probed. Filtering on ARITY meant an
    // operation written `(...args)` exempted itself, because `Function.length`
    // is a proxy for "takes a request" and answers 0 for that shape.
    //
    // Passing a request to an operation that takes none is harmless — it ignores
    // the argument and reads nothing, so it passes trivially. That is what lets
    // the enumeration be unconditional, and an unconditional enumeration is the
    // only kind a new operation cannot fall out of.
    for (const [name, fn] of Object.entries(service)) {
      const probe = accessorRequest(PROBE_FIELDS);
      const result = await (fn as (request: unknown) => Promise<{ status: string; reason?: string }>)(probe.request);
      const fired = Object.keys(probe.fired());
      if (fired.length > 0) {
        offenders.push(`${name} read ${fired.join(", ")}`);
        continue;
      }
      // The SECONDARY assertion, and the only part that needs the classification:
      // reading nothing is necessary and not sufficient for an operation that is
      // supposed to consume a request — it must also answer with the refusal
      // rather than having quietly ignored the caller.
      if (DECLARED_REQUEST_SHAPE[name as keyof PreparationServiceV1] === "request"
        && result.reason !== REQUEST_CAPTURE_REFUSAL) {
        offenders.push(`${name} did not give the capture refusal`);
      }
    }
    // NAMED, not counted: a bare count says the invariant broke and not where.
    expect(offenders).toEqual([]);
  });
});

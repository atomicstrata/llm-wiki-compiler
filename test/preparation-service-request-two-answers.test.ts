/**
 * @file test/preparation-service-request-two-answers.test.ts
 * @description The two request fields that were read TWICE in one expression.
 *
 * `gate`'s `reasonCode` and `handoff`'s `obligations` were each read once to test
 * for `undefined` and once to store or pass, so the observation that decided a
 * value was PRESENT and the value that got USED were two different reads of a
 * caller's object. That is the same defect the `supersedesBundleId` fix closed,
 * one layer out.
 *
 * WHAT THESE CASES CAN AND CANNOT WITNESS, stated because the difference bounds
 * the claim. Once the request is read into a frozen own-data record, "read once"
 * and "read twice" are INDISTINGUISHABLE — nothing runs between the two reads of
 * a data property, so no probe can tell them apart. The read-once discipline is
 * therefore a redundancy rather than an independently testable property, and
 * what these cases pin is the mechanism that makes the second answer
 * unreachable: the accessor is refused before it ever runs.
 *
 * Each request is otherwise complete — a run standing at its gate, a ready
 * preparation with a real obligation set — so removing the capture lets the
 * operation reach the second answer and act on it.
 */

import { describe, expect, it } from "vitest";
import { REQUEST_CAPTURE_REFUSAL } from "../src/preparations/service-request-capture.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { SEED_GATE_ID, gateServiceOn, gatedRun, readGateRun } from "./preparation-gate-fixture.js";
import { readRun, serviceOn } from "./preparation-recovery-fixture.js";
import { handoffObligations, stageReadyPreparation } from "./preparations/handoff-fixture.js";
import type { PreparationGrant } from "../src/preparations/principals.js";

/** Every grant these operations charge. */
const GRANTS: readonly PreparationGrant[] = ["preparation.run", "preparation.gate.decide"];

/** One refusal, as every operation's refused arm renders it. */
interface RefusalLike { readonly status: string; readonly reason?: string }

/** A field that answers with a DIFFERENT value on its second read. */
function twoAnswers(first: unknown, second: unknown): { field: PropertyDescriptor; reads: () => number } {
  let reads = 0;
  return {
    field: {
      enumerable: true, configurable: true,
      get() { reads += 1; return reads === 1 ? first : second; },
    },
    reads: () => reads,
  };
}

describe("preparation service two-answer request fields", () => {
  const root = useTempRoot();

  it("refuses a gate reason code that answers differently, and decides no gate", async () => {
    const fixture = await gatedRun("twoanswergate");
    try {
      const before = JSON.stringify(await readGateRun(fixture));
      // The first answer is admissible and the second is not. Reading the
      // request's own data makes the pair unreachable rather than merely
      // making the guard read whichever one it happened to reach.
      const reason = twoAnswers("clean-code", "not a component");
      const request: Record<string, unknown> = {
        runId: fixture.binding.runId, gateId: SEED_GATE_ID, decision: "approved",
      };
      Object.defineProperty(request, "reasonCode", reason.field);

      const result = await gateServiceOn(fixture.root, "sdk", GRANTS)
        .gate(request as never) as RefusalLike;

      expect(result.status).toBe("refused");
      expect(result.reason).toBe(REQUEST_CAPTURE_REFUSAL);
      expect(reason.reads()).toBe(0);
      expect(JSON.stringify(await readGateRun(fixture))).toBe(before);
    } finally { await fixture.cleanup(); }
  });

  it("refuses handoff obligations that answer differently, and stages no bundle", async () => {
    const binding = await stageReadyPreparation(root.dir);
    // BOTH answers are complete obligation sets, differing only in the slug they
    // compile. Without the capture the operation tests one and stages the other.
    const obligations = twoAnswers(handoffObligations(binding, "ada"), handoffObligations(binding, "bob"));
    const request: Record<string, unknown> = { runId: binding.runId };
    Object.defineProperty(request, "obligations", obligations.field);

    const result = await serviceOn(root.dir, "sdk", GRANTS).handoff(request as never) as RefusalLike;

    expect(result.status).toBe("refused");
    expect(result.reason).toBe(REQUEST_CAPTURE_REFUSAL);
    expect(obligations.reads()).toBe(0);
    expect((await readRun({ root: root.dir, binding } as never)).state).toBe("handoff-ready");
  });
});

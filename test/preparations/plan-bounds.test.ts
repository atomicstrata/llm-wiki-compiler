/**
 * @file test/preparations/plan-bounds.test.ts
 * @description Exercises worst-case envelope arithmetic and the pinned handoff
 * subset. Over-ceiling worst cases, understated declared bounds, and unsafe
 * intermediates all fail closed with the exact dimension; a plan is never
 * clamped. The five one-byte-over Milestone A handoff caps are checked exactly.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_HANDOFF_ACTIVE_STORE_BYTES, MAX_HANDOFF_AGGREGATE_PAYLOAD_BYTES,
  MAX_HANDOFF_ITEM_PAYLOAD_BYTES, MAX_HANDOFF_MANIFEST_BYTES,
  MAX_HANDOFF_RUN_EVIDENCE_BYTES, MAX_HANDOFF_RUN_EVIDENCE_ITEM_BYTES,
} from "../../src/preparations/constants.js";
import { computePreparationWorstCase } from "../../src/preparations/plan-bounds.js";
import { parsePreparationPlan } from "../../src/preparations/plan-parse.js";
import { PreparationBoundsError } from "../../src/preparations/problems.js";
import { planText, validPlan } from "./plan-fixture.js";

type Plan = Record<string, any>;
const phases = (plan: Plan): any[] => plan.phases as any[];
const handoff = (plan: Plan): any => plan.outputContract.handoffCapacity;

/** Parse a mutated plan and assert it fails closed on one exact dimension. */
function expectDimension(mutate: (plan: Plan) => Plan, dimension: string): void {
  try {
    parsePreparationPlan(planText(mutate(validPlan())));
  } catch (error) {
    expect(error).toBeInstanceOf(PreparationBoundsError);
    expect((error as PreparationBoundsError).dimension).toBe(dimension);
    return;
  }
  throw new Error(`expected rejection on ${dimension}`);
}

describe("worst-case envelope", () => {
  it("computes the exact per-dimension worst case from expansion", () => {
    const env = computePreparationWorstCase(parsePreparationPlan(planText(validPlan())));
    expect(env).toMatchObject({ phaseInstances: 7, attempts: 14, invocations: 14, transitions: 28, evidenceRefs: 21, tokens: 1400 });
  });

  it("rejects an over-ceiling worst case rather than clamping", () => {
    expectDimension((plan) => { phases(plan)[1].expansion.maximumItems = 256; return plan; }, "phase-instances");
  });

  it("rejects an understated declared bound", () => {
    expectDimension((plan) => { plan.bounds.maximumTransitions = 0; return plan; }, "transitions");
  });

  it("fails closed on an unsafe arithmetic intermediate", () => {
    expectDimension((plan) => { phases(plan)[1].bounds.maximumTokensPerAttempt = Number.MAX_SAFE_INTEGER; return plan; }, "tokens-arithmetic");
  });
});

describe("pinned Milestone A handoff caps", () => {
  const OVER: Array<[string, (plan: Plan) => Plan]> = [
    ["handoff-item-payload", (plan) => { handoff(plan).includedEvidenceClasses[0].maximumAggregateBytes = MAX_HANDOFF_AGGREGATE_PAYLOAD_BYTES; handoff(plan).includedEvidenceClasses[0].maximumItemBytes = MAX_HANDOFF_ITEM_PAYLOAD_BYTES + 1; return plan; }],
    ["handoff-aggregate-payload", (plan) => { handoff(plan).maximumBundlePayloadBytes = MAX_HANDOFF_AGGREGATE_PAYLOAD_BYTES + 1; return plan; }],
    ["handoff-manifest", (plan) => { handoff(plan).maximumManifestBytes = MAX_HANDOFF_MANIFEST_BYTES + 1; return plan; }],
    ["handoff-run-evidence-item", (plan) => { handoff(plan).maximumRunEvidenceItemBytes = MAX_HANDOFF_RUN_EVIDENCE_ITEM_BYTES + 1; return plan; }],
    ["handoff-run-evidence", (plan) => { handoff(plan).maximumRunEvidenceBytes = MAX_HANDOFF_RUN_EVIDENCE_BYTES + 1; return plan; }],
    ["handoff-active-store", (plan) => { handoff(plan).maximumActiveStoreContributionBytes = MAX_HANDOFF_ACTIVE_STORE_BYTES + 1; return plan; }],
  ];

  it.each(OVER)("rejects one byte over the %s cap", (dimension, mutate) => {
    expectDimension(mutate, dimension);
  });
});

describe("handoff downstream envelope consistency", () => {
  const singleClass = (aggregate: number, item: number, items: number) => ({
    classId: "review", maximumItems: items, maximumItemBytes: item, maximumAggregateBytes: aggregate,
  });

  it("rejects class aggregates that exceed the declared bundle payload envelope", () => {
    expectDimension((plan) => {
      handoff(plan).maximumBundlePayloadBytes = MAX_HANDOFF_AGGREGATE_PAYLOAD_BYTES;
      handoff(plan).includedEvidenceClasses = [0, 1, 2].map((index) => ({
        ...singleClass(MAX_HANDOFF_AGGREGATE_PAYLOAD_BYTES, MAX_HANDOFF_ITEM_PAYLOAD_BYTES, 10), classId: `review-${index}`,
      }));
      return plan;
    }, "handoff-aggregate-envelope");
  });

  it("rejects a class aggregate that exceeds its own item budget", () => {
    expectDimension((plan) => {
      handoff(plan).includedEvidenceClasses = [singleClass(4_194_304, 1_048_576, 2)];
      return plan;
    }, "handoff-class-envelope");
  });

  it("rejects one byte over the class-aggregate envelope sum", () => {
    expectDimension((plan) => {
      handoff(plan).maximumBundlePayloadBytes = 33_554_432;
      handoff(plan).includedEvidenceClasses = [singleClass(33_554_433, 1_048_576, 100)];
      return plan;
    }, "handoff-aggregate-envelope");
  });

  it("rejects a class whose item bytes exceed its aggregate", () => {
    expectDimension((plan) => {
      handoff(plan).includedEvidenceClasses = [singleClass(1_048_576, 2_097_152, 4)];
      return plan;
    }, "handoff-class-consistency");
  });

  it("accepts class aggregates that sum exactly to the bundle payload envelope", () => {
    const object = validPlan();
    (object.outputContract as any).handoffCapacity.maximumBundlePayloadBytes = 33_554_432;
    (object.outputContract as any).handoffCapacity.includedEvidenceClasses = [singleClass(33_554_432, MAX_HANDOFF_ITEM_PAYLOAD_BYTES, 10)];
    expect(parsePreparationPlan(planText(object)).outputContract.handoffCapacity?.maximumBundlePayloadBytes).toBe(33_554_432);
  });
});

describe("closed expansion policies parse", () => {
  it("accepts map overflow fail-closed and repeat non-convergence dispositions", () => {
    const failClosed = validPlan();
    (failClosed.phases as any[])[1].expansion.overflowDisposition = { kind: "fail-closed" };
    expect(parsePreparationPlan(planText(failClosed)).phases[1].expansion.kind).toBe("map");

    const repeat = validPlan();
    (repeat.phases as any[])[1].expansion = {
      kind: "bounded-repeat", maximumIterations: 3, continuation: { kind: "until-empty", outputField: "remaining" },
      limitDisposition: { kind: "count-as-incomplete", completenessClassId: "nonconvergence" },
    };
    expect(parsePreparationPlan(planText(repeat)).phases[1].expansion.kind).toBe("bounded-repeat");
  });
});

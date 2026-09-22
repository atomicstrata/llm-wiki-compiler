/**
 * @file test/preparation-capacity-matrix-bounds.test.ts
 * @description Exact cap-boundary coverage for the launch ceilings a plan's
 * DECLARED worst-case envelope is checked against
 * (`src/preparations/plan-bounds.ts:100-122`), and the at-cap half of the pinned
 * Milestone A handoff subset (`src/preparations/plan-bounds.ts:155-174`).
 *
 * Seven of the twelve declared dimensions carry a ceiling; five deliberately do
 * not. Both halves are asserted, and the union is checked against the declared
 * bounds block, so a dimension that gained or lost a ceiling cannot slip past
 * this file unnoticed.
 *
 * The handoff caps already have one-byte-over coverage in
 * `test/preparations/plan-bounds.test.ts`. What was missing is the other half:
 * that a plan sitting EXACTLY on each pinned cap is admitted rather than
 * refused. A cap only proven from above is equally consistent with a cap set one
 * unit too low.
 */

import { describe, expect, it } from "vitest";
import { parsePreparationPlan } from "../src/preparations/plan-parse.js";
import { PreparationBoundsError } from "../src/preparations/problems.js";
import { planText, validPlan } from "./preparations/plan-fixture.js";
import {
  MAX_ATTEMPTS_PER_PHASE_INSTANCE, MAX_CHECKPOINT_BYTES_PER_RUN, MAX_EVIDENCE_REFS_PER_RUN,
  MAX_HANDOFF_ACTIVE_STORE_BYTES, MAX_HANDOFF_AGGREGATE_PAYLOAD_BYTES,
  MAX_HANDOFF_ITEM_PAYLOAD_BYTES, MAX_HANDOFF_MANIFEST_BYTES, MAX_HANDOFF_RUN_EVIDENCE_BYTES,
  MAX_HANDOFF_RUN_EVIDENCE_ITEM_BYTES, MAX_INVOCATIONS_PER_RUN, MAX_PHASE_INSTANCES_PER_RUN,
  MAX_RETAINED_EVIDENCE_BYTES, MAX_TRANSITIONS_PER_RUN,
} from "../src/preparations/constants.js";

/** One declared dimension, its launch ceiling, and its refusal name. */
type CeilingCase = readonly [string, number, string];

const CEILINGS: readonly CeilingCase[] = [
  ["maximumPhaseInstances", MAX_PHASE_INSTANCES_PER_RUN, "phase-instances"],
  ["maximumAttempts", MAX_PHASE_INSTANCES_PER_RUN * MAX_ATTEMPTS_PER_PHASE_INSTANCE, "attempts"],
  ["maximumInvocations", MAX_INVOCATIONS_PER_RUN, "invocations"],
  ["maximumTransitions", MAX_TRANSITIONS_PER_RUN, "transitions"],
  ["maximumEvidenceRefs", MAX_EVIDENCE_REFS_PER_RUN, "evidence-refs"],
  ["maximumEvidenceBytes", MAX_RETAINED_EVIDENCE_BYTES, "evidence-bytes"],
  ["maximumCheckpointBytes", MAX_CHECKPOINT_BYTES_PER_RUN, "checkpoint-bytes"],
];

/** The declared dimensions `boundChecks` deliberately leaves unbounded. */
const UNCAPPED = [
  "maximumBrokerRequests", "maximumEffects", "maximumTokens", "maximumTimeMs", "maximumCostMicros",
] as const;

/** Parse a plan whose declared bounds carry one overridden dimension. */
function parseWithBound(field: string, value: number): void {
  const plan = validPlan();
  (plan.bounds as Record<string, number>)[field] = value;
  parsePreparationPlan(planText(plan));
}

/** Parse a plan mutated in place, returning whatever it threw. */
function parseMutated(mutate: (plan: Record<string, any>) => void): unknown {
  const plan = validPlan();
  mutate(plan);
  try {
    parsePreparationPlan(planText(plan));
  } catch (error) {
    return error;
  }
  return null;
}

describe("declared launch ceilings", () => {
  it.each(CEILINGS)("admits %s declared at exactly its ceiling", (field, ceiling) => {
    expect(() => parseWithBound(field, ceiling)).not.toThrow();
  });

  it.each(CEILINGS)("refuses %s one unit over its ceiling, naming the dimension", (field, ceiling, dimension) => {
    const caught = parseMutated((plan) => { plan.bounds[field] = ceiling + 1; });

    expect(caught).toBeInstanceOf(PreparationBoundsError);
    expect(caught).toMatchObject({ dimension });
  });

  it.each(UNCAPPED)("leaves %s deliberately unbounded above its computed worst case", (field) => {
    // Not an oversight to be tightened silently: `boundChecks` passes `undefined`
    // for these, so the only rule is that a declared bound may not UNDERSTATE the
    // computed worst case. Asserting it keeps a future ceiling from arriving
    // without a boundary test beside it.
    expect(() => parseWithBound(field, Number.MAX_SAFE_INTEGER)).not.toThrow();
  });

  it("accounts for every declared dimension exactly once", () => {
    const declared = Object.keys(validPlan().bounds as Record<string, number>).sort();

    expect([...CEILINGS.map(([field]) => field), ...UNCAPPED].sort()).toEqual(declared);
  });
});

describe("pinned Milestone A handoff caps at exactly their limit", () => {
  const AT_CAP: ReadonlyArray<readonly [string, (handoff: Record<string, any>) => void]> = [
    ["handoff-aggregate-payload", (handoff) => { handoff.maximumBundlePayloadBytes = MAX_HANDOFF_AGGREGATE_PAYLOAD_BYTES; }],
    ["handoff-manifest", (handoff) => { handoff.maximumManifestBytes = MAX_HANDOFF_MANIFEST_BYTES; }],
    ["handoff-run-evidence-item", (handoff) => { handoff.maximumRunEvidenceItemBytes = MAX_HANDOFF_RUN_EVIDENCE_ITEM_BYTES; }],
    ["handoff-run-evidence", (handoff) => { handoff.maximumRunEvidenceBytes = MAX_HANDOFF_RUN_EVIDENCE_BYTES; }],
    ["handoff-active-store", (handoff) => { handoff.maximumActiveStoreContributionBytes = MAX_HANDOFF_ACTIVE_STORE_BYTES; }],
    ["handoff-item-payload", (handoff) => {
      // An item cap cannot exceed its class aggregate, and a class aggregate
      // cannot exceed the declared bundle payload, so reaching the item cap
      // requires raising both — the envelope rules, not incidental setup.
      handoff.maximumBundlePayloadBytes = MAX_HANDOFF_AGGREGATE_PAYLOAD_BYTES;
      handoff.includedEvidenceClasses[0].maximumAggregateBytes = MAX_HANDOFF_AGGREGATE_PAYLOAD_BYTES;
      handoff.includedEvidenceClasses[0].maximumItemBytes = MAX_HANDOFF_ITEM_PAYLOAD_BYTES;
    }],
  ];

  it.each(AT_CAP)("admits a plan sitting exactly on the %s cap", (_dimension, mutate) => {
    expect(parseMutated((plan) => mutate(plan.outputContract.handoffCapacity))).toBeNull();
  });

  it("admits a plan sitting on every pinned cap at once", () => {
    expect(parseMutated((plan) => {
      for (const [, mutate] of AT_CAP) mutate(plan.outputContract.handoffCapacity);
    })).toBeNull();
  });
});

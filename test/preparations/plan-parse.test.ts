/**
 * @file test/preparations/plan-parse.test.ts
 * @description Exercises the bounded, duplicate-key-free normalized-plan parser:
 * the positive baseline, exact-shape rebuild, digest recompute honesty, and the
 * optional workflow-parent and supersession-shape edges.
 */

import { describe, expect, it } from "vitest";
import {
  parsePreparationPlan, preparationPlanDigest, verifyPreparationPlanDigest,
} from "../../src/preparations/plan-parse.js";
import { PreparationPlanError } from "../../src/preparations/problems.js";
import { planText, validPlan } from "./plan-fixture.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("parsePreparationPlan", () => {
  it("accepts and rebuilds the complete valid plan", () => {
    const plan = parsePreparationPlan(planText(validPlan()));
    expect(plan.schemaVersion).toBe(1);
    expect(plan.phases.map((phase) => phase.logicalPhaseId)).toEqual(["collect", "expand", "review", "join"]);
    expect(plan.outputContract.handoffCapacity?.maximumManifestBytes).toBe(1_048_576);
  });

  it("recomputes a stable canonical plan digest", () => {
    const plan = parsePreparationPlan(planText(validPlan()));
    const digest = preparationPlanDigest(plan);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifyPreparationPlanDigest(plan, digest)).toBe(digest);
  });

  it("rejects a plan digest that disagrees with its recomputation", () => {
    const plan = parsePreparationPlan(planText(validPlan()));
    expect(() => verifyPreparationPlanDigest(plan, DIGEST)).toThrow(PreparationPlanError);
  });

  it("accepts an optional workflow parent and supersession-shape edge", () => {
    const object = validPlan();
    object.workflowParent = { workflowRunId: "wfr-1", workflowId: "wf-1", workflowDigest: DIGEST };
    object.supersedesPreparationId = `prp_${"b".repeat(32)}`;
    const plan = parsePreparationPlan(planText(object));
    expect(plan.workflowParent?.workflowId).toBe("wf-1");
    expect(plan.supersedesPreparationId).toBe(`prp_${"b".repeat(32)}`);
  });

  it("rejects a malformed supersession id shape", () => {
    const object = validPlan();
    object.supersedesPreparationId = "prp_not-hex";
    expect(() => parsePreparationPlan(planText(object))).toThrow();
  });
});

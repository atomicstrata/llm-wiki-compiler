/**
 * @file test/preparations/plan-graph.test.ts
 * @description Exercises closed phase-graph validation: dependency edges,
 * cycles, output connectivity, map-source domination, required/optional inputs,
 * ephemeral restrictions, atomicity-class consistency, supersession shape, and
 * the deterministic topological ranks consumed by the scheduler.
 */

import { describe, expect, it } from "vitest";
import { parsePreparationPlan } from "../../src/preparations/plan-parse.js";
import { validatePlanSupersession, validatePreparationPlanGraph } from "../../src/preparations/plan-graph.js";
import { PreparationPlanError } from "../../src/preparations/problems.js";
import { planText, validPlan } from "./plan-fixture.js";

type Plan = Record<string, any>;
const phases = (plan: Plan): any[] => plan.phases as any[];
const reject = (mutate: (plan: Plan) => Plan): void =>
  expect(() => parsePreparationPlan(planText(mutate(validPlan())))).toThrow(PreparationPlanError);

/** Turn the durable baseline into an ephemeral-read plan that parses cleanly. */
function ephemeralBase(): Plan {
  const plan = validPlan();
  plan.executionMode = "ephemeral-read";
  (plan.initialInputSet as Record<string, unknown>).retention = "terminal-only";
  plan.outputContract = { producingPhaseIds: ["join"] };
  phases(plan).splice(2, 1);
  phases(plan)[2].dependsOn = ["expand"];
  phases(plan)[2].inputBindings = [{ bindingId: "expanded", sourceKind: "phase-output", sourcePhaseId: "expand" }];
  return plan;
}

describe("phase dependency graph", () => {
  it("rejects self, unknown, and cyclic dependencies", () => {
    reject((plan) => { phases(plan)[0].dependsOn = ["collect"]; return plan; });
    reject((plan) => { phases(plan)[0].dependsOn = ["ghost"]; return plan; });
    reject((plan) => { phases(plan)[0].dependsOn = ["join"]; return plan; });
  });

  it("rejects disconnected work and undominated map sources", () => {
    reject((plan) => { plan.outputContract.producingPhaseIds = ["collect"]; return plan; });
    reject((plan) => { phases(plan)[1].inputBindings = [{ bindingId: "collected", sourceKind: "initial-input" }]; return plan; });
  });

  it("rejects required work resting only on optional predecessors", () => {
    reject((plan) => { phases(plan)[0].disposition = "optional"; return plan; });
  });

  it("derives deterministic topological ranks", () => {
    const graph = validatePreparationPlanGraph(parsePreparationPlan(planText(validPlan())));
    expect([...graph.topologicalRankByPhaseId]).toEqual([["collect", 0], ["expand", 1], ["review", 2], ["join", 3]]);
  });
});

describe("mode and atomicity consistency", () => {
  it("accepts an ephemeral-read plan without durable constructs", () => {
    expect(parsePreparationPlan(planText(ephemeralBase())).executionMode).toBe("ephemeral-read");
  });

  it("rejects ephemeral handoff and repeat constructs", () => {
    expect(() => parsePreparationPlan(planText((() => { const plan = ephemeralBase(); plan.outputContract.handoffCapacity = (validPlan().outputContract as Record<string, unknown>).handoffCapacity; return plan; })()))).toThrow();
    expect(() => parsePreparationPlan(planText((() => {
      const plan = ephemeralBase();
      phases(plan)[1].expansion = { kind: "bounded-repeat", maximumIterations: 2, continuation: { kind: "fixed-count", count: 1 }, limitDisposition: { kind: "fail-closed" } };
      return plan;
    })()))).toThrow();
    expect(() => parsePreparationPlan(planText((() => { const plan = ephemeralBase(); plan.initialInputSet.retention = "audit"; return plan; })()))).toThrow();
  });

  it("rejects atomicity classes inconsistent with effects and handoff", () => {
    reject((plan) => { phases(plan)[0].effectPlanDigest = `sha256:${"a".repeat(64)}`; return plan; });
    reject((plan) => ({ ...plan, atomicityClass: "external-effect-only" }));
    reject((plan) => ({ ...plan, atomicityClass: "non-atomic-external-before-local" }));
  });
});

describe("supersession shape", () => {
  const id = `prp_${"a".repeat(32)}`;
  it("rejects self-reference and malformed ids, accepts a distinct target", () => {
    expect(() => validatePlanSupersession(id, id)).toThrow(PreparationPlanError);
    expect(() => validatePlanSupersession(id, "prp_bad")).toThrow();
    expect(validatePlanSupersession(id, `prp_${"b".repeat(32)}`)).toBe(`prp_${"b".repeat(32)}`);
  });
});

/**
 * @file test/preparations/plan-negative-sweep.test.ts
 * @description The closed-grammar negative matrix. Every case clones the valid
 * plan, injects one forbidden field, unknown enum, malformed digest, unsafe
 * component, or nonrepresentable value, and asserts the loader fails closed.
 * A representative valid manifest is never enough; each incompatible field is
 * exercised on its own.
 */

import { describe, expect, it } from "vitest";
import { parsePreparationPlan } from "../../src/preparations/plan-parse.js";
import { planText, validPlan } from "./plan-fixture.js";

type Plan = Record<string, any>;
const phases = (plan: Plan): any[] => plan.phases as any[];
const repeat = (plan: Plan): Plan => {
  phases(plan)[1].expansion = {
    kind: "bounded-repeat", maximumIterations: 3,
    continuation: { kind: "fixed-count", count: 2 }, limitDisposition: { kind: "fail-closed" },
  };
  return plan;
};

const CASES: Array<[string, (plan: Plan) => Plan]> = [
  ["unknown top-level field", (plan) => ({ ...plan, extra: 1 })],
  ["missing required field", (plan) => { delete plan.workspaceId; return plan; }],
  ["wrong schema version", (plan) => ({ ...plan, schemaVersion: 2 })],
  ["unknown execution mode", (plan) => ({ ...plan, executionMode: "streamed" })],
  ["unknown atomicity class", (plan) => ({ ...plan, atomicityClass: "atomic" })],
  ["unknown phase role", (plan) => { phases(plan)[0].role = "orchestrate"; return plan; }],
  ["unknown expansion kind", (plan) => { phases(plan)[0].expansion = { kind: "fan-out" }; return plan; }],
  ["unknown continuation kind", (plan) => { repeat(plan); phases(plan)[1].expansion.continuation = { kind: "forever" }; return plan; }],
  ["unknown gate kind", (plan) => { phases(plan)[2].gate.gateKind = "confirm-anything"; return plan; }],
  ["unknown executor kind", (plan) => { phases(plan)[0].executor = { kind: "shell" }; return plan; }],
  ["unknown overflow disposition", (plan) => { phases(plan)[1].expansion.overflowDisposition = { kind: "truncate" }; return plan; }],
  ["unknown item identity", (plan) => { phases(plan)[1].expansion.itemIdentity = "index"; return plan; }],
  ["unknown duplicate disposition", (plan) => { phases(plan)[1].expansion.duplicateDisposition = "keep"; return plan; }],
  ["unknown sensitivity", (plan) => { plan.initialInputSet.sensitivity = "secret"; return plan; }],
  ["unknown retention", (plan) => { plan.initialInputSet.retention = "forever"; return plan; }],
  ["unknown evidence producer", (plan) => { plan.initialInputSet.producer = { kind: "agent" }; return plan; }],
  ["untrusted marker not true", (plan) => { plan.initialInputSet.untrusted = false; return plan; }],
  ["malformed digest", (plan) => ({ ...plan, recipeDigest: "not-a-digest" })],
  ["short digest", (plan) => ({ ...plan, recipeDigest: `sha256:${"a".repeat(63)}` })],
  ["unsafe workspace component", (plan) => ({ ...plan, workspaceId: "team/research" })],
  ["unsafe logical phase id", (plan) => { phases(plan)[0].logicalPhaseId = "../collect"; return plan; }],
  ["unsafe capability id", (plan) => { phases(plan)[0].executor.capabilityId = "a/b"; return plan; }],
  ["unsafe handler id", (plan) => { phases(plan)[1].executor.handlerId = ".hidden"; return plan; }],
  ["unsafe completeness class id", (plan) => { phases(plan)[1].expansion.overflowDisposition.completenessClassId = "x/y"; return plan; }],
  ["duplicate logical phase id", (plan) => { phases(plan)[1].logicalPhaseId = "collect"; return plan; }],
  ["work phase missing executor", (plan) => { delete phases(plan)[0].executor; return plan; }],
  ["gate phase carrying executor", (plan) => { phases(plan)[2].executor = phases(plan)[0].executor; return plan; }],
  ["work phase carrying gate", (plan) => { phases(plan)[0].gate = { gateId: "g", gateKind: "confirm-cost" }; return plan; }],
  ["gate phase carrying broker digest", (plan) => { phases(plan)[2].brokerPlanDigest = `sha256:${"a".repeat(64)}`; return plan; }],
  ["fixed count over maximum iterations", (plan) => { repeat(plan); phases(plan)[1].expansion.continuation = { kind: "fixed-count", count: 9 }; return plan; }],
  ["map maximum items below one", (plan) => { phases(plan)[1].expansion.maximumItems = 0; return plan; }],
  ["byte count is an unsafe integer", (plan) => { plan.initialInputSet.byteCount = 9_999_999_999_999_999; return plan; }],
  ["negative byte count", (plan) => { plan.initialInputSet.byteCount = -1; return plan; }],
  ["handoff design digest mismatch", (plan) => { plan.outputContract.handoffCapacity.milestoneADesignDigest = `sha256:${"a".repeat(64)}`; return plan; }],
  ["handoff missing field", (plan) => { delete plan.outputContract.handoffCapacity.maximumManifestBytes; return plan; }],
  ["input binding missing source phase", (plan) => { phases(plan)[1].inputBindings[0] = { bindingId: "collected", sourceKind: "phase-output" }; return plan; }],
  ["initial input binding with source phase", (plan) => { phases(plan)[0].inputBindings[0] = { bindingId: "seed", sourceKind: "initial-input", sourcePhaseId: "collect" }; return plan; }],
];

describe("normalized plan negative grammar sweep", () => {
  it.each(CASES)("rejects: %s", (_name, mutate) => {
    expect(() => parsePreparationPlan(planText(mutate(validPlan())))).toThrow();
  });
});

describe("bounded JSON document rejections", () => {
  it("rejects a duplicate object key", () => {
    const text = planText(validPlan()).replace('"workspaceId":"research"', '"workspaceId":"research","workspaceId":"research"');
    expect(() => parsePreparationPlan(text)).toThrow();
  });

  it("rejects trailing content after the plan", () => {
    expect(() => parsePreparationPlan(`${planText(validPlan())} trailing`)).toThrow();
  });
});

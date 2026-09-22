/**
 * @file test/preparations/ephemeral-eligibility.test.ts
 * @description Ephemeral-read SHAPE eligibility: a durable plan is rejected with
 * the typed refusal, and the eligibility classifier agrees with the plan-graph on
 * what an ephemeral read may declare — a read-only brokered call is permitted
 * while a mutating external effect disqualifies the plan. This is plan-shape
 * classification only; executable ephemeral read is Task 4's.
 */

import { describe, expect, it } from "vitest";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import {
  ephemeralIneligibility, EphemeralIneligibleError, assertEphemeralEligible,
} from "../../src/preparations/ephemeral.js";
import { parsePreparationPlan } from "../../src/preparations/plan-parse.js";
import type { PhaseExpansionV1 } from "../../src/preparations/plan-types.js";
import { ephemeralBrokerPlan, ephemeralEffectPlanObject } from "./inputs-fixture.js";
import { fixturePlan } from "./store-fixture.js";

describe("ephemeral-read shape eligibility", () => {
  it("rejects a durable plan with the typed refusal", () => {
    expect(ephemeralIneligibility(fixturePlan())).not.toBeNull();
    expect(() => assertEphemeralEligible(fixturePlan())).toThrow(EphemeralIneligibleError);
  });

  it("agrees with plan-graph on permitted brokers versus rejected effects", () => {
    expect(ephemeralIneligibility(ephemeralBrokerPlan())).toBeNull();
    expect(() => parsePreparationPlan(JSON.stringify(ephemeralEffectPlanObject()))).toThrow();
    const broker = ephemeralBrokerPlan();
    const withEffect = { ...broker, phases: [{ ...broker.phases[0]!, effectPlanDigest: parseSha256Digest(`sha256:${"d".repeat(64)}`) }] };
    expect(ephemeralIneligibility(withEffect)).toBe("external-effect-required");
  });

  // The loader refuses this shape outright, so it can only arrive from a CALLER
  // handing over a plan-shaped object the loader never saw — which is exactly
  // what the executable ephemeral read accepts. On that path this classifier IS
  // the gate, and a phase that budgets a per-attempt effect without declaring an
  // effect plan can mutate just as surely as one that declares it.
  it("rejects a phase that budgets an effect it never declared", () => {
    const base = ephemeralBrokerPlan();
    const budgeted = { ...base.phases[0]!, bounds: { ...base.phases[0]!.bounds, maximumEffectsPerAttempt: 1 } };
    expect(ephemeralIneligibility({ ...base, phases: [budgeted, ...base.phases.slice(1)] }))
      .toBe("external-effect-required");
  });

  it("rejects durable retention and bounded-repeat expansion when classifying directly", () => {
    const base = ephemeralBrokerPlan();
    const audit = { ...base, initialInputSet: { ...base.initialInputSet, retention: "audit" as const } };
    expect(ephemeralIneligibility(audit)).toBe("durable-retention-required");
    const repeat: PhaseExpansionV1 = { kind: "bounded-repeat", maximumIterations: 2, continuation: { kind: "fixed-count", count: 1 }, limitDisposition: { kind: "fail-closed" } };
    const phases = [{ ...base.phases[0]!, expansion: repeat }, ...base.phases.slice(1)];
    expect(ephemeralIneligibility({ ...base, phases })).toBe("durable-repeat-required");
  });
});

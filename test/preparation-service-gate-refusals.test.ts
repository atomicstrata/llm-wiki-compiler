/**
 * @file test/preparation-service-gate-refusals.test.ts
 * @description Every way the `gate` operation declines, kept apart on purpose.
 *
 * COULD-NOT-DERIVE IS NOT DOES-NOT-QUALIFY, at every leg. A plan that declares
 * no such gate is a does-not-qualify — the operator named something that does not
 * exist. A gate whose input comes from a phase that has not produced anything yet
 * is a could-not-derive — the gate is real and the run simply has not got there.
 * Collapsing them told an operator their plan was wrong when the truth was that
 * they were early, which is the taxonomy this program keeps having to re-separate.
 *
 * AND THE CAPTURE CASE. A request field re-read after an `await` retargets the
 * decision at a gate or a run the caller never named; the probe mutates the
 * request object the instant the call returns and requires the durable record to
 * name what was passed.
 */

import { describe, expect, it } from "vitest";
import { GATE_RECORDABLE_RUN_STATES } from "../src/preparations/service.js";
import type { GateResultV1 } from "../src/preparations/service.js";
import { stateOnlyTransitionStates } from "../src/preparations/run-validation.js";
import {
  REVIEW_GATE_GRANTS, SEED_GATE_ID, gateProject, gateServiceOn, gatedRun, readGateRun,
  type GateFixture,
} from "./preparation-gate-fixture.js";

/** Decide one gate id on a fixture through a granted `sdk` service. */
function decide(fixture: GateFixture, gateId = SEED_GATE_ID): Promise<GateResultV1> {
  return gateServiceOn(fixture.root, "sdk", REVIEW_GATE_GRANTS).gate({
    runId: fixture.binding.runId, gateId, decision: "approved",
  });
}

/** The refusal reason, or a message naming what came back instead. */
function refusalOf(result: GateResultV1): string {
  return result.status === "refused" ? result.reason : `expected a refusal, got ${result.status}`;
}

describe("gate refuses without recording, and says which kind of no it is", () => {
  it("does-not-qualify: the plan declares no gate by that name", async () => {
    const fixture = await gatedRun("gateunknown");
    try {
      expect(refusalOf(await decide(fixture, "no-such-gate"))).toMatch(/declares no gate named/);
      expect((await readGateRun(fixture)).gateProofs).toHaveLength(0);
    } finally { await fixture.cleanup(); }
  });

  it("could-not-derive: the gate's upstream phase has produced nothing yet", async () => {
    // The SAME base plan, with its gate left bound to an upstream phase output.
    // The refusal is about the run being early, not about the plan being wrong.
    const fixture = await gatedRun("gateupstream", { upstreamBound: true });
    try {
      expect(refusalOf(await decide(fixture))).toMatch(/produced no durable output evidence yet/);
    } finally { await fixture.cleanup(); }
  });

  it("does-not-qualify: the run is in a state no decision can be carried at", async () => {
    // A freshly staged run is `planned`, which is not in the derived recordable
    // set — a decision there would have to MOVE the run to be recorded at all.
    const fixture = await gateProject("gateplanned");
    try {
      expect(refusalOf(await decide(fixture))).toMatch(/cannot be recorded while this run is planned/);
      expect((await readGateRun(fixture)).state).toBe("planned");
    } finally { await fixture.cleanup(); }
  });

  it("does-not-qualify: the decision is not one of the three", async () => {
    const fixture = await gatedRun("gatebogus");
    try {
      const result = await gateServiceOn(fixture.root, "sdk", REVIEW_GATE_GRANTS).gate({
        runId: fixture.binding.runId, gateId: SEED_GATE_ID, decision: "maybe" as never,
      });
      expect(refusalOf(result)).toMatch(/not one of the three gate decisions/);
      expect((await readGateRun(fixture)).gateProofs).toHaveLength(0);
    } finally { await fixture.cleanup(); }
  });

  it("could-not-see: no such run, and the store is not claimed empty for it", async () => {
    const fixture = await gatedRun("gatenorun");
    try {
      const result = await gateServiceOn(fixture.root, "sdk", REVIEW_GATE_GRANTS).gate({
        runId: "prr_00000000000000000000000000000000", gateId: SEED_GATE_ID, decision: "approved",
      });
      expect(refusalOf(result)).toMatch(/no such preparation run/);
    } finally { await fixture.cleanup(); }
  });
});

describe("the recordable-state set is derived, not restated", () => {
  it("is exactly the states a gate-decided append leaves in place", () => {
    // ANTI-VACUITY: the expected value is spelled out, so a derivation that
    // silently returned an empty set could not satisfy the equality below.
    expect([...GATE_RECORDABLE_RUN_STATES].sort()).toEqual(["awaiting-gate", "running"]);
    expect([...GATE_RECORDABLE_RUN_STATES].sort())
      .toEqual([...stateOnlyTransitionStates("gate-decided")].sort());
  });

  it("excludes recovery-required, which the type may target but cannot self-edge", () => {
    // The fact that makes the derivation worth having: a hand-written set copied
    // from the type's target table would have admitted a state where the append
    // throws.
    //
    // WHAT THIS DOES NOT MEAN, stated because an earlier revision of this comment
    // drew the wrong conclusion from it: it does NOT mean a parked run can carry
    // no approval. A proof is a durable ledger entry and nothing binds it to the
    // state it was written in, so one recorded while the run was `running`
    // survives the park — measured in `preparation-gate-binding.test.ts`. What it
    // means is narrower: a decision cannot be TAKEN once the run is already
    // parked.
    expect(GATE_RECORDABLE_RUN_STATES.has("recovery-required")).toBe(false);
  });
});

describe("the request is captured before the first await", () => {
  it("records the gate the caller named, not one substituted afterwards", async () => {
    const fixture = await gatedRun("gatecapture");
    try {
      const request = { runId: fixture.binding.runId, gateId: SEED_GATE_ID, decision: "approved" as const };
      const pending = gateServiceOn(fixture.root, "sdk", REVIEW_GATE_GRANTS).gate(request);
      // Mutated the instant the synchronous prologue returned. A field re-read
      // after any await would bind the proof to a gate the caller never chose.
      (request as { gateId: string }).gateId = "no-such-gate";
      expect(await pending).toMatchObject({ status: "recorded", gateId: SEED_GATE_ID });
      expect((await readGateRun(fixture)).gateProofs[0]?.gateId).toBe(SEED_GATE_ID);
    } finally { await fixture.cleanup(); }
  });
});

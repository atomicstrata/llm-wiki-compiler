/**
 * @file test/preparation-parkable-states.test.ts
 * @description The DERIVED set of states a stranded run may be parked from, and
 * the vocabulary it is derived within.
 *
 * A DERIVED SET IS NOT SELF-PROVING. Deriving `PARKABLE_RUN_STATES` removes the
 * drift risk between it and `OWNER_ACTIVE_STATES`; it supplies no coverage at
 * all, and this program has watched a member dropped from a derived set leave
 * 7,700 tests green. So each member is asserted, and each subtraction is
 * asserted with the reason it was subtracted.
 *
 * AND THE VOCABULARY MATTERS AS MUCH AS THE MEMBERS. `awaiting-gate` is ONE
 * STRING ACROSS THREE UNIONS in this repository:
 *
 *   - `PreparationRunState` — the run level, which this set is about
 *   - `PhaseInstanceState` — the phase level, in the SAME FILE
 *   - `StageStatus` in `src/workflows` — a different domain entirely
 *
 * A grep for the string reaches all three, so "13 occurrences" is not evidence
 * about any one of them. The type system keeps them apart here; this asserts it
 * where a reader can see it, because a label carrying meaning it does not own is
 * how a confident wrong answer gets made.
 */

import { rm } from "node:fs/promises";
import { describe, it, expect } from "vitest";
import { cliPreparationService } from "../src/commands/preparation/host.js";
import { stagedRunIn } from "./preparation-cli-fixture.js";
import { PARKABLE_RUN_STATES, parkAttemptForRecoveryLocked } from "../src/preparations/recovery.js";
import { CANCEL_SETTLEABLE_RUN_STATES } from "../src/preparations/attempts/cancel-settlement.js";
import {
  LEGAL_EDGES, OWNER_ACTIVE_STATES,
} from "../src/preparations/run-validation.js";
import {
  PHASE_INSTANCE_STATES, PREPARATION_RUN_STATES, PREPARATION_TRANSITION_TYPES,
} from "../src/preparations/run-types.js";

describe("the parkable set is derived, and every member earns its place", () => {
  it("is exactly the owner-active states no other recovery leg owns", () => {
    expect([...PARKABLE_RUN_STATES].sort())
      .toEqual(["awaiting-gate", "paused", "running"]);
  });

  it.each([["running"], ["paused"], ["awaiting-gate"]] as const)(
    "%s is owner-active and has a legal edge to recovery-required", (state) => {
      // BOTH halves per member. Owner-active is why the advisory custody leg
      // subtracts it — leaving it with no cancel consumer — and the legal edge
      // is what makes parking it a traversal rather than a new transition.
      expect(OWNER_ACTIVE_STATES.has(state)).toBe(true);
      expect(LEGAL_EDGES[state].has("recovery-required")).toBe(true);
      expect(PARKABLE_RUN_STATES.has(state)).toBe(true);
    });

  it.each([
    ["handoff-started", "the handoff recovery leg settles or parks it against the Milestone A pair"],
    ["cancelling", "the cancel settlement advances it to its honest terminal"],
  ] as const)("excludes %s, because %s", (state, _reason) => {
    // EACH SUBTRACTION WITH ITS REASON. A state excluded for no recorded reason
    // is one a later reader adds back "for symmetry".
    expect(OWNER_ACTIVE_STATES.has(state)).toBe(true);
    expect(PARKABLE_RUN_STATES.has(state)).toBe(false);
  });

  it("refuses a non-parkable state even when the owner DOES fence the attempt", async () => {
    // THE STATE HALF OF THE GUARD, ISOLATED — and the reason it needed its own
    // case is a measurement. The guard is `!PARKABLE.has(state) || !fences(...)`,
    // and the existing substrate test builds a `planned` run with NO owner, so
    // the OWNER half fires whatever the state set says. Making `planned`
    // parkable leaves that test green: it never witnessed the state check at
    // all. Not a weakening introduced by rewording it — it was never a witness —
    // but "the property is unchanged" is only worth saying once something can
    // see the property.
    //
    // Here the owner fences exactly, so the state is the ONLY thing that can
    // refuse. The guard runs before any I/O, so a synthetic run reaches it.
    const attemptId = "att-fencing" as never;
    const run = {
      state: "cancelling" as const,
      executionOwner: { attemptId, leaseNonce: "nonce-1" },
    } as never;
    await expect(parkAttemptForRecoveryLocked({
      root: "/nonexistent", binding: {} as never, run,
      phaseInstanceId: "phi-x" as never, attemptId, leaseNonce: "nonce-1",
      principal: { id: "op", surface: "cli" }, at: "2026-08-08T00:00:00.000Z",
    })).rejects.toThrow(/owner-active run whose owner/);
  });

  it("refuses to park a cancelling run, and the settlement still owns it", async () => {
    // THE SUBTRACTION AS BEHAVIOUR, not just as set membership. A subtraction
    // encodes "another leg owns this state", so the test is BOTH halves: the
    // park declines it AND the owning leg still selects it. Assert only the
    // first and the subtraction becomes a refusal with no successor — the
    // strand class, one state over.
    const { cwd, binding } = await stagedRunIn("parkcancelling", "cancelling");
    try {
      const outcome = await cliPreparationService(cwd).recovery({ runId: binding.runId });
      expect(outcome).toMatchObject({
        status: "refused",
        reason: expect.stringContaining("only a run holding an execution owner can be parked"),
      });
      // ...and the leg that DOES own it still selects the state.
      expect(CANCEL_SETTLEABLE_RUN_STATES.has("cancelling")).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("excludes cancelling by the settleable set rather than by name", () => {
    // The derivation subtracts a SET, not a string. If that set ever grows, the
    // parkable set must shrink with it rather than keeping a stale literal.
    for (const state of CANCEL_SETTLEABLE_RUN_STATES) {
      expect(PARKABLE_RUN_STATES.has(state)).toBe(false);
    }
  });
});

describe("the set is scoped to the RUN vocabulary, which shares strings with two others", () => {
  it("contains only durable run states", () => {
    for (const state of PARKABLE_RUN_STATES) {
      expect(PREPARATION_RUN_STATES).toContain(state);
    }
  });

  it("pins the RUN-and-PHASE overlap, derived rather than listed", () => {
    // EIGHT SHARED STRINGS, not one — and three of the four states this slice
    // turns on are in here: `running` and `awaiting-gate` are parkable, and
    // `recovery-required` is the park TARGET. Derived from the two unions so a
    // ninth shared member has to be acknowledged rather than absorbed; a
    // hand-written list beside two derivable unions is the tell this program
    // keeps finding.
    const shared = PREPARATION_RUN_STATES
      .filter((state) => (PHASE_INSTANCE_STATES as readonly string[]).includes(state));
    expect([...shared].sort()).toEqual([
      "awaiting-gate", "cancelled", "failed", "recovery-required",
      "running", "succeeded", "succeeded-with-warnings", "superseded",
    ]);
  });

  it("has only ONE member unambiguous across all three vocabularies", () => {
    // AND IT IS NOT `paused`. An earlier version of this file used `paused` as
    // the discriminating member because it is a run state and not a phase
    // state — true, and not enough: `paused` is also a TRANSITION TYPE in this
    // same file, so grepping it hits two vocabularies. `planned` is the only
    // run state absent from both siblings.
    //
    // WHAT SEPARATES THEM IS THE TYPE SYSTEM, NOT THE STRING. `PARKABLE_RUN_STATES`
    // is typed to the run union, which is the real defence; this asserts the
    // hazard it defends against, so a reader does not conclude from a grep that
    // a name means one thing here.
    const runOnly = PREPARATION_RUN_STATES.filter((state) =>
      !(PHASE_INSTANCE_STATES as readonly string[]).includes(state)
      && !(PREPARATION_TRANSITION_TYPES as readonly string[]).includes(state));
    expect(runOnly).toEqual(["planned"]);
    expect(PREPARATION_TRANSITION_TYPES).toContain("paused");
  });
});

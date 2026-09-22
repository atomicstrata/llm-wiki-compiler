/**
 * @file test/preparations/cancel-consumer-sets.test.ts
 * @description The derived sets that decide who can consume a cancellation
 * advisory, and the drift each derivation exists to catch.
 *
 * A DERIVED SET IS NOT SELF-PROVING. It still needs a case per member and a case
 * that would go red if a subtrahend were dropped — otherwise the derivation is a
 * comment with parentheses. So each set here is asserted against its exact value
 * (anti-vacuity: an empty derivation would satisfy a subset check perfectly) AND
 * against the property that makes the derivation the right one.
 *
 * WHY THESE SETS EXIST AT ALL. Four separate consumers can act on an advisory,
 * each with its own enumeration; the question "will anything ever act on this
 * one?" is the union and the complement of those, and it was previously answered
 * by a test of TERMINALITY, which is one sufficient reason mistaken for the rule.
 */

import { describe, expect, it } from "vitest";
import {
  ADVISORY_UNCONSUMED_RUN_STATES, CANCEL_HONORABLE_RUN_STATES,
  CANCEL_SETTLEABLE_RUN_STATES,
} from "../../src/preparations/attempts/cancel-settlement.js";
import { ATTEMPT_STARTABLE_RUN_STATES } from "../../src/preparations/attempts/types.js";
import { LEGAL_EDGES, OWNER_ACTIVE_STATES } from "../../src/preparations/run-validation.js";
import type { PreparationRunState } from "../../src/preparations/run-types.js";

/** Every declared run state, from the edge table's own keys. */
const ALL_STATES = Object.keys(LEGAL_EDGES) as PreparationRunState[];

/** The states whose edge set admits `cancelling` — the raw acceptance set. */
const ACCEPTS_CANCELLING = ALL_STATES.filter((state) => LEGAL_EDGES[state].has("cancelling"));

describe("the unconsumed set is the strand, derived from every consumer", () => {
  it("is exactly the handoff-ready state today", () => {
    expect([...ADVISORY_UNCONSUMED_RUN_STATES]).toEqual(["handoff-ready"]);
  });

  it("subtracts the executor's own startable states", () => {
    // `planned` accepts `cancelling` and is NOT a strand, because an attempt can
    // still start there and poll the advisory. Dropping this subtrahend would
    // have the sweep cancel every planned run the moment anything took the lock.
    expect(ACCEPTS_CANCELLING).toContain("planned");
    expect(ATTEMPT_STARTABLE_RUN_STATES.has("planned")).toBe(true);
    expect(ADVISORY_UNCONSUMED_RUN_STATES.has("planned")).toBe(false);
  });

  it("subtracts the states the settlement leg already selects", () => {
    expect(ACCEPTS_CANCELLING).toContain("recovery-required");
    expect(CANCEL_SETTLEABLE_RUN_STATES.has("recovery-required")).toBe(true);
    expect(ADVISORY_UNCONSUMED_RUN_STATES.has("recovery-required")).toBe(false);
  });

  it("subtracts every state that can hold an execution owner", () => {
    // The safety half. `paused` and `awaiting-gate` accept `cancelling` and no
    // consumer covers them either — but a sweep running inside an unrelated
    // mutation's acquisition cannot tell a stranded owner from a busy one, so
    // they keep the attempt path as their consumer rather than being carried.
    for (const state of ["paused", "awaiting-gate"] as const) {
      expect(ACCEPTS_CANCELLING).toContain(state);
      expect(OWNER_ACTIVE_STATES.has(state)).toBe(true);
      expect(ADVISORY_UNCONSUMED_RUN_STATES.has(state)).toBe(false);
    }
  });
});

describe("the honorable set replaces a test of terminality", () => {
  it("is exactly the states some consumer can act from", () => {
    expect([...CANCEL_HONORABLE_RUN_STATES].sort()).toEqual([
      "awaiting-gate", "cancelling", "handoff-ready", "paused", "planned",
      "recovery-required", "running",
    ]);
  });

  it("excludes handoff-started, which has edges but none to cancelling", () => {
    // THE STATE THE OLD RULE ADMITTED. Terminality was empty-edge-set, and this
    // state has two edges — so a request published here was permitted and could
    // then only ever be collected as residue while the handoff completed anyway.
    expect(LEGAL_EDGES["handoff-started"].size).toBeGreaterThan(0);
    expect(LEGAL_EDGES["handoff-started"].has("cancelling")).toBe(false);
    expect(ATTEMPT_STARTABLE_RUN_STATES.has("handoff-started")).toBe(false);
    expect(CANCEL_HONORABLE_RUN_STATES.has("handoff-started")).toBe(false);
  });

  it("still excludes every terminal, so nothing the old rule caught is lost", () => {
    const terminals = ALL_STATES.filter((state) => LEGAL_EDGES[state].size === 0);
    // ANTI-VACUITY: the count is pinned, so a derivation that found no terminals
    // could not satisfy the emptiness check that follows.
    expect(terminals).toHaveLength(8);
    expect(terminals.filter((state) => CANCEL_HONORABLE_RUN_STATES.has(state))).toEqual([]);
  });

  it("and the two sets together cover every declared state exactly once", () => {
    const unhonorable = ALL_STATES.filter((state) => !CANCEL_HONORABLE_RUN_STATES.has(state));
    expect(unhonorable.length + CANCEL_HONORABLE_RUN_STATES.size).toBe(ALL_STATES.length);
    expect(unhonorable.sort()).toEqual([
      "abandoned", "cancelled", "cancelled-with-effects", "failed", "handed-off",
      "handoff-started", "succeeded", "succeeded-with-warnings", "superseded",
    ].sort());
  });
});

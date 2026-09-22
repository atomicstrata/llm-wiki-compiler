/**
 * @file test/preparation-reset-project-scope.test.ts
 * @description Reset's authorization is over the PROJECT'S KEY EPOCH, not over a
 * lifecycle unit — v10 §4's reset-ordering rule, which the C3 row briefly
 * contradicted.
 *
 * THE PLAN SAYS IT IN THE HEADING: *"one universal existential rule is wrong
 * because reset is PROJECT-scoped, not unit-scoped."* Its receipt enumerates
 * project scope and its protocol supersedes a SET of intent-only units. Two
 * consequences follow, and both were violated by giving reset a per-unit ticket:
 *
 *  - **Pending prune/sweep/quarantine units do NOT block reset.** The plan's own
 *    words: "Reset exists precisely for the broken-key state in which other
 *    pending work cannot be trusted; blocking it on their pendingness would
 *    deadlock the one project state reset exists to repair."
 *  - **A single-unit ticket cannot authorize a set-wide supersession**, and it
 *    cannot bind the continuation either — the continuation is authenticated by
 *    the operator's secret, under the lock, which is strictly stronger.
 *
 * THE FIRST CASE WAS A RATIFIED TEST OBLIGATION THAT WAS NEVER BUILT. §7 slice
 * 10.1 requires "the G2 reset-ordering fixtures (reset pending refuses prune
 * resume; prune pending does not refuse reset)". The first half shipped as the
 * resume-reachability control; the second half is below, and had it existed when
 * the gate landed, the C3 row could not have shipped.
 *
 * EVERY PENDING UNIT HERE IS A GENUINELY CRASHED ONE, never a planted marker. A
 * marker written by a test is a shape resembling the state; a crashed prune is
 * the state, and only the real one carries the registry entries and receipts the
 * gate actually reads.
 *
 * WHICH CASES REPRODUCE A DEFECT AND WHICH DO NOT, stated because the difference
 * was measured and is not obvious. Run against the pre-fix source with this
 * file's own corrected helper:
 *
 *  - the two pending-prune cases go **RED**. They reproduce the first defect.
 *  - the continuation-identity and supersession cases stay **GREEN**.
 *
 * THE SECOND DEFECT HAD NO BEHAVIOURAL SIGNATURE, and that is the whole reason
 * it survived review. The gate authorized one unit while the executor completed
 * another — but the executor was never wrong, because it never CONSULTED the
 * ticket: the continuation is authenticated by the operator's secret and the
 * supersession classifies per unit under the lock. A discarded authorization
 * cannot be observed in an outcome. So those two cases are REGRESSION GUARDS on
 * behaviour that was already correct, not reproductions, and calling them
 * reproductions would claim evidence they do not carry.
 *
 * WHAT DOES WITNESS THE SECOND DEFECT is the structural case below: reset takes
 * no unit ticket at all, so there is no per-unit authorization left to disagree
 * with anything. The type system now carries most of that guarantee — `reset` is
 * not a `DestructiveGateIntent`, so the ticket-returning acquisition cannot be
 * handed it — and a compile-time impossibility beats a test.
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPreparationService } from "../src/preparations/service.js";
import type { PreparationPrincipal, PreparationServiceV1 } from "../src/preparations/service.js";
import { acquireMutationLock } from "../src/operation-bundles/lock-gate.js";
import type { ProjectScopedGateIntent } from "../src/operation-bundles/lock-gate.js";
import { releaseLock } from "../src/utils/lock.js";
import { PREPARATION_QUARANTINE_SEGMENT } from "../src/preparations/paths.js";
import { MISSING_KEY_CONFIRMATION } from "../src/preparations/reset.js";
import { readdir } from "node:fs/promises";
import {
  pruneStagedThenCrashed, removePreparationKey, stagePreparation,
} from "./preparations/lifecycle-fixture.js";

/** Far enough in the past that the thirty-day retention floor is cleared. */
const LONG_AGO = "2026-01-01T00:00:00.000Z";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "prep-reset-scope-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/** The service as `host.ts` builds it: `cli`, local operator. */
function cliService(): PreparationServiceV1 {
  const principal = { id: "cli-operator", surface: "cli", grants: [] } as PreparationPrincipal;
  return createPreparationService({
    root, surface: "cli", principals: { principalFor: () => principal },
  });
}

/**
 * Every reset unit still holding a PENDING INTENT MARKER.
 *
 * THE MARKER, NOT THE DIRECTORY, and the difference was measured rather than
 * assumed. Both completing and superseding remove `reset-intent.json` and leave
 * the unit directory behind — empty after a supersede, holding the signed
 * receipt after a completion — so counting directories answers a different
 * question than "what is still pending", and answers it wrongly. Pendingness is
 * what the gate and the substrate both read, so it is what these cases assert.
 */
async function resetUnits(): Promise<string[]> {
  const quarantine = path.join(root, ".llmwiki", PREPARATION_QUARANTINE_SEGMENT);
  const entries = (await readdir(quarantine).catch(() => [] as string[]))
    .filter((entry) => entry.startsWith("rst-"));
  const pending: string[] = [];
  for (const entry of entries) {
    const leaves = await readdir(path.join(quarantine, entry)).catch(() => [] as string[]);
    if (leaves.includes("reset-intent.json")) pending.push(entry);
  }
  return pending.sort();
}

/** Record one first-pass intent, returning its unit and secret. */
async function passOne(): Promise<{ unitId: string; token: string }> {
  const outcome = await cliService().reset({ confirmation: MISSING_KEY_CONFIRMATION });
  if (outcome.status !== "intent-recorded") {
    throw new Error(`pass one did not record: ${JSON.stringify(outcome)}`);
  }
  return { unitId: outcome.unitId, token: outcome.continuationToken };
}

describe("other operations' pending units do not block a project reset", () => {
  it("permits reset while a REAL crashed prune is pending", async () => {
    // THE OBLIGATION §7 NAMED AND NOBODY BUILT: "prune pending does not refuse
    // reset". The prune is genuinely crashed at a durable seam, so its unit is
    // pending in the registry the gate reads — not a marker a test wrote.
    const crashed = await pruneStagedThenCrashed(root, LONG_AGO);
    expect(crashed.unitId).toMatch(/^prn-/u);
    await removePreparationKey(root);
    const outcome = await cliService().reset({ confirmation: MISSING_KEY_CONFIRMATION });
    // BOTH THE KEY AND THE PENDING WORK ARE STRANDED IF THIS REFUSES. Reset is
    // the verb that clears the wreckage, so refusing it because wreckage exists
    // is the guard-that-strands class from the other side.
    expect(outcome).toMatchObject({ status: "intent-recorded" });
  });

  it("completes the whole two-pass repair with that prune still pending", async () => {
    // A REFUSAL IS NOT THE ONLY WAY TO STRAND. Pass one succeeding while pass
    // two refuses would leave the project holding a reset marker AND a prune
    // unit, which is strictly worse than never starting.
    await pruneStagedThenCrashed(root, LONG_AGO);
    await removePreparationKey(root);
    const { unitId, token } = await passOne();
    const completed = await cliService().reset({
      confirmation: MISSING_KEY_CONFIRMATION, continuation: { unitId, token },
    });
    expect(completed).toMatchObject({ status: "completed", unitId });
  });
});

/** Plant two valid pending intents so project scope differs observably from unit scope. */
async function twoPendingIntents() {
  await stagePreparation(root);
  await removePreparationKey(root);
  const first = await passOne();
  const second = await plantSecondIntent(first.unitId);
  expect(await resetUnits()).toHaveLength(2);
  return { first, second };
}

describe("the continuation authorizes the unit it executes", () => {
  it("completes the named unit when a SECOND pending marker exists", async () => {
    // TWO VALID PENDING INTENTS, which is the only arrangement that can tell a
    // per-unit ticket from a project-scoped authorization: with one marker, a
    // ticket naming the wrong unit is indistinguishable from a right one.
    const { first, second } = await twoPendingIntents();
    const completed = await cliService().reset({
      confirmation: MISSING_KEY_CONFIRMATION,
      continuation: { unitId: second.unitId, token: second.token },
    });
    // THE IDENTITY, not that both succeeded: the unit that completed must be the
    // unit the request named, and the other marker must be untouched.
    expect(completed).toMatchObject({ status: "completed", unitId: second.unitId });
    expect(await resetUnits()).toEqual([first.unitId]);
  });
});

describe("there is no per-unit authorization left to disagree with", () => {
  it("acquires reset through the ticket-free form, and the gate hands back none", async () => {
    // THE STRUCTURAL WITNESS FOR THE SECOND DEFECT. Its symptom — gate
    // authorizes `rst-aaa`, executor completes `rst-zzz` — was invisible in
    // every outcome, because the ticket was discarded rather than misapplied.
    // The fix is that no ticket exists: the acquisition returns a plain boolean.
    await stagePreparation(root);
    await removePreparationKey(root);
    await passOne();
    const acquired = await acquireMutationLock(root, "reset");
    expect(acquired).toBe(true);
    await releaseLock(root);
    // AND THE COMPILE-TIME HALF, which is the stronger one: `reset` is not a
    // `DestructiveGateIntent`, so `acquirePreparationMutationLock` — the form
    // that returns a unit ticket — cannot be handed it at all. A misapplied
    // reset ticket is now unrepresentable rather than merely absent.
    const resetIsNotPerUnit: ProjectScopedGateIntent = "reset";
    expect(resetIsNotPerUnit).toBe("reset");
  });
});

describe("supersession is authorized over every marker it clears", () => {
  it("clears BOTH pending markers, and reports both", async () => {
    // A SINGLE-UNIT TICKET CANNOT COVER THIS. Supersede deletes a SET, so an
    // authorization naming one unit while two are deleted is check-and-executor
    // disagreement by construction — which is what the C3 row produced.
    const { first, second } = await twoPendingIntents();
    const superseded = await cliService().reset({
      confirmation: MISSING_KEY_CONFIRMATION, supersede: true,
    });
    expect(superseded.status).toBe("intent-recorded");
    const remaining = await resetUnits();
    // Both originals are gone, and exactly the fresh marker remains.
    expect(remaining).not.toContain(first.unitId);
    expect(remaining).not.toContain(second.unitId);
    expect(remaining).toHaveLength(1);
  });
});

/**
 * Record a SECOND first-pass intent beside an existing one.
 *
 * The substrate refuses a second pass one while any intent is pending, which is
 * correct and is exactly what makes two live markers hard to reach. Reaching it
 * honestly: move the first marker aside, record the second through the real
 * protocol, then restore the first — so both are genuine protocol output rather
 * than hand-written files.
 */
async function plantSecondIntent(existing: string): Promise<{ unitId: string; token: string }> {
  const { rename } = await import("node:fs/promises");
  const quarantine = path.join(root, ".llmwiki", PREPARATION_QUARANTINE_SEGMENT);
  // PARKED OUTSIDE THE STORE, not renamed within it. A directory parked beside
  // its siblings under the quarantine root is an entry the scanner cannot
  // classify, which makes the observation INCOMPLETE and refuses for a reason
  // that has nothing to do with what is under test — measured, on the first run
  // of this fixture.
  const parked = await mkdtemp(path.join(os.tmpdir(), "prep-parked-"));
  const parkedUnit = path.join(parked, existing);
  await rename(path.join(quarantine, existing), parkedUnit);
  const second = await passOne();
  await rename(parkedUnit, path.join(quarantine, existing));
  await rm(parked, { recursive: true, force: true });
  return second;
}

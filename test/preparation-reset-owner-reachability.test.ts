/**
 * @file test/preparation-reset-owner-reachability.test.ts
 * @description The reachability control the ratified plan requires for
 * `project-key-reset`: a project holding a pending reset must still be
 * completable by the operator who started it.
 *
 * THE HAZARD, IN ONE SENTENCE: a reset that records its intent and stops leaves
 * a pending `project-key-reset` unit, and if the gate refuses every acquisition
 * while that unit is pending, the operator can neither finish the reset they
 * started, nor supersede it, nor do anything else with the project.
 *
 * HOW THE GATE CLOSES FOR EVERYONE ELSE. `gatePreparationLifecycle` sends a
 * non-destructive intent to `refusePendingPreparationLifecycle`, which refuses
 * whenever any unit is pending, and a per-unit destructive intent to
 * `refuseVisibleResetCustody`, which refuses specifically because the pending
 * unit is a reset holding custody of every other unit's leaves. The first two
 * cases witness each branch, so the closure is measured rather than argued.
 *
 * AND HOW RESET ITSELF GETS THROUGH — this is the part that changed. `reset`
 * takes a THIRD arm of the dispatch, before the destructive split: it is
 * PROJECT-scoped, so it receives **no ticket**, owns no unit, and no pending
 * unit refuses it. Its authorization is the project lock plus the protocol's own
 * under-lock recheck.
 *
 * THIS DOCBLOCK USED TO DESCRIBE THE OPPOSITE, and it is worth recording because
 * a future reader would otherwise rebuild it. It said "the owner rule IS the
 * fix": that `reset` maps to `project-key-reset`, which makes it a destructive
 * intent, which lets the per-unit owner rule hand it "the ticket for its OWN
 * pending unit". **That model is RETRACTED** (reconciliation R-11). It closed
 * this wedge and opened two others — a pending unit belonging to a DIFFERENT
 * operation refused the reset outright, stranding a broken key behind a crashed
 * prune; and the ticket it handed over named one unit while the executor
 * completed another, unobservably, because nothing consumed it.
 *
 * The guarantee is unchanged and is what all three cases still assert: **a
 * project holding a pending reset is completable by a principal holding
 * `preparation.quarantine`** — the same token that recorded the intent. Only the
 * mechanism that delivers it changed, from a per-unit ticket to a project-scoped
 * arm that needs none.
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import {
  acquireMutationLock, acquirePreparationMutationLock,
} from "../src/operation-bundles/lock-gate.js";
import type { DestructiveGateIntent } from "../src/operation-bundles/lock-gate.js";
import { releaseLock } from "../src/utils/lock.js";
import { resetAwaitingContinuation as seedResetContinuation } from "./preparations/crash-fixture.js";

const AT = "2026-08-10T00:00:00.000Z";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "prep-reset-owner-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/** Leave the project holding a `project-key-reset` unit awaiting its continuation. */
async function resetAwaitingContinuation(): Promise<void> {
  // PIN THE PRECONDITION. If pass one did not record, every refusal below would
  // be a refusal of nothing and all three cases would pass for the wrong reason.
  await seedResetContinuation(root, AT);
}

/** Acquire destructively and release, returning what the gate said. */
async function acquireDestructive(intent: DestructiveGateIntent) {
  const acquisition = await acquirePreparationMutationLock(root, intent);
  if (acquisition.acquired) await releaseLock(root);
  return acquisition;
}

describe("a pending reset closes both branches of the gate", () => {
  it("refuses every NON-destructive acquisition while the reset is unfinished", async () => {
    await resetAwaitingContinuation();
    // `ordinary` is what stage, fail, pause, resume and gate all acquire at.
    await expect(acquireMutationLock(root, "ordinary")).rejects.toThrow();
  });

  it("refuses every OTHER destructive acquisition, by the custody rule", async () => {
    await resetAwaitingContinuation();
    await expect(acquireDestructive("prune")).rejects.toThrow(/reset .* is unfinished/u);
  });
});

describe("the reset owner can still act while its own unit is pending", () => {
  it("acquires without a ticket, because its authority is over the project", async () => {
    // THE CASE THAT MUST PASS BEFORE A RESET SURFACE SHIPS. With both other
    // branches closed, this is the only way a project holding a pending reset
    // makes any progress at all — completing the reset, or superseding its
    // marker. If this refuses, the operator's own repair verb cannot reach the
    // state its first pass created.
    // RE-POINTED WITH THE PROJECT-SCOPED MODEL, and the property is unchanged:
    // the operator's own repair verb must reach the state its first pass
    // created. What changed is HOW it is authorized — reset takes no unit
    // ticket, because its authority is over the project's key epoch rather than
    // over one unit, so it acquires through the ticket-free form.
    await resetAwaitingContinuation();
    const acquired = await acquireMutationLock(root, "reset");
    expect(acquired).toBe(true);
    await releaseLock(root);
  });
});

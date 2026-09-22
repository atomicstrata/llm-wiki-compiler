/**
 * @file test/preparation-destructive-fixture.ts
 * @description Shared setup for the destructive-surface suites — the gate's
 * owner rule, the `prune` and `sweep` service operations, and their fault and
 * race cases.
 *
 * Extracted for the reason the CLI and SDK fixtures were: these suites build the
 * same three states, and the half a copy loses first is the PRECONDITION
 * assertion. A "the registry cannot be bound" helper that silently stopped
 * faulting would leave every case using it green against a healthy project, so
 * the helper asserts the fault it installs rather than trusting it.
 */

import { gateDecision } from "./preparations/lifecycle-fixture.js";
import { chmod, mkdir, mkdtemp, rm, symlink, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { PREPARATION_QUARANTINE_SEGMENT } from "../src/preparations/paths.js";
import { preparationPaths } from "../src/preparations/paths.js";
import { scanPreparationInventory } from "../src/preparations/capacity.js";
import { acquireLock, releaseLock } from "../src/utils/lock.js";
import { LIFECYCLE_ACTOR, stagePreparation } from "./preparations/lifecycle-fixture.js";
import { prunePreparationRunLocked } from "../src/preparations/retention.js";
import { pruneUnitIdFor } from "../src/preparations/prune-delete.js";
import type { PreparationRunBinding } from "../src/preparations/run-types.js";

/**
 * Replace one lifecycle registry with a symlink so it cannot be BOUND.
 *
 * A symlinked registry root is the fault the two degradation paths are defined
 * against, and which registry it is decides the answer: a prune-confined fault
 * degrades for ordinary mutations by shipped contract, while a quarantine one
 * must refuse because it can hide a pending reset.
 *
 * @param root - The project whose registry is to be faulted.
 * @param segment - The registry's path segment under `.llmwiki`.
 */
export async function symlinkRegistry(root: string, segment: string): Promise<void> {
  const registry = path.join(root, ".llmwiki", segment);
  const decoy = path.join(root, `${path.basename(segment)}-decoy`);
  await mkdir(decoy, { recursive: true });
  await rm(registry, { recursive: true, force: true });
  await symlink(decoy, registry);
}

/** Stage a preparation and delete its run leaf, leaving a provable orphan. */
export async function orphanOnePreparation(root: string): Promise<void> {
  const { binding } = await stagePreparation(root);
  await rm(preparationPaths(root, binding.workspaceId).runFile(binding.runId), { force: true });
}

/**
 * Run one operation with the project lock already HELD by someone else.
 *
 * The re-read afterwards is the load-bearing half: a busy-lock refusal that had
 * already deleted something would satisfy the returned value and nothing else,
 * and for these two verbs that is the failure that matters.
 *
 * @param root - The project whose lock is taken.
 * @param attempt - The operation to run while the lock is held.
 * @param expectedManifests - How many preparations must still be there after.
 */
export async function expectBusyLockRefusal(
  root: string,
  attempt: () => Promise<{ status: string }>,
  expectedManifests: number,
): Promise<void> {
  await acquireLock(root, { quiet: true });
  try {
    expect(await attempt()).toEqual({ status: "refused", reason: "project lock is busy" });
  } finally {
    await releaseLock(root);
  }
  expect((await scanPreparationInventory(root)).manifests.length).toBe(expectedManifests);
}

/**
 * Make one temporary project root for a suite that faults the quarantine
 * registry, and take it down again afterwards.
 *
 * THE TEARDOWN IS THE REASON THIS IS SHARED. Several cases strip the registry's
 * mode to make it unobservable, and a root left at 0o000 cannot be removed — so
 * the NEXT suite inherits a temp directory it did not create, and the failure
 * surfaces somewhere unrelated. Restoring the mode before `rm` is easy to write
 * once and easy to forget per file.
 *
 * @param prefix - Distinguishes this suite's roots in the temp directory.
 * @returns Make and remove, for a `beforeEach`/`afterEach` pair.
 */
export function faultableProjectRoot(prefix: string) {
  return {
    async make(): Promise<string> {
      return mkdtemp(path.join(os.tmpdir(), prefix));
    },
    async remove(root: string): Promise<void> {
      if (!root) return;
      await chmod(path.join(root, ".llmwiki", PREPARATION_QUARANTINE_SEGMENT), 0o700).catch(() => {});
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Crash a prune of one ALREADY-TERMINAL run after its first object is staged,
 * and return the unit it left pending.
 *
 * Shared because two suites build this state for different reasons — one to
 * exercise the owner rule, one to fault the observation around it — and the
 * seam it crashes at is the load-bearing detail: `afterStaged` has already
 * destroyed the run leaf, which is what makes the resume path the only way back.
 *
 * @param root - The project holding the terminal run.
 * @param binding - The run to prune, already driven terminal and past the floor.
 * @param at - The instant the crashed attempt records.
 */
/**
 * Seed one destructive unit while another is HIDDEN, so both end up pending.
 *
 * NEEDED BECAUSE SHIPPED VERBS CAN NO LONGER BUILD THIS STATE. The gate refuses a
 * fresh destructive operation while any foreign unit is pending — "complete the
 * operation that owns it first" — and the driver now re-runs that predicate over
 * its own capture, so the direct-substrate route these fixtures used to take is
 * closed too. That closure is the point of the change; it is also why a
 * multi-unit registry has to be assembled rather than driven.
 *
 * NOTHING IS FORGED. Both units are produced by real crashed operations against
 * real signed state; one is simply moved out of the registry while the other is
 * created, then moved back. The same technique the gate/driver race reproduction
 * used, for the same reason.
 *
 * WHAT THIS MEANS FOR THE CASES BUILT ON IT, stated so nobody infers more: the
 * multi-unit states below are now reachable only in a project that predates this
 * change, or through operator intervention — not through any shipped sequence.
 * The owner rule they assert still runs on every destructive acquisition, so it
 * still has to be right; it is defence in depth rather than a live path.
 *
 * @param registryDir - The registry holding the unit to hide.
 * @param unitId - The unit to hide for the duration.
 * @param seed - Creates the second unit while the first is invisible.
 */
export async function withUnitHidden<T>(
  registryDir: string, unitId: string, seed: () => Promise<T>,
): Promise<T> {
  const live = path.join(registryDir, unitId);
  const parked = path.join(registryDir, "..", `parked-${unitId}`);
  await rename(live, parked);
  try {
    return await seed();
  } finally {
    await rename(parked, live);
  }
}

export async function crashPruneOf(
  root: string, binding: PreparationRunBinding, at: string,
): Promise<string> {
  await expect(prunePreparationRunLocked(root, {
    authorization: gateDecision("prune", pruneUnitIdFor(binding.runId)),
        target: { kind: "run", binding }, actor: LIFECYCLE_ACTOR, at,
    clock: { now: () => new Date() },
    faults: { afterStaged: async () => { throw new Error("crash"); } },
  })).rejects.toThrow("crash");
  return pruneUnitIdFor(binding.runId);
}

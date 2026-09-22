/**
 * @file test/preparations/lifecycle-fixture.ts
 * @description Shared harness for the Wave O4 Task 9 lifecycle suites
 * (abandonment, quarantine, key reset, prune, sweep, references, races). It
 * stages a real durable preparation, drives its run to a requested control state
 * through the authenticated locked appenders, and exposes the byte-level
 * tampering used to forge an integrity-invalid run or a missing/unreadable key.
 * Nothing here re-signs unverifiable history: every transition flows through the
 * production writer, and every fault mutates raw leaf bytes exactly as a crash or
 * a lost key would.
 */

import type { LifecycleAuthorizationV1 } from "../../src/operation-bundles/lock-gate.js";
import { chmod, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PREPARATION_PRUNE_REGISTRY } from "../../src/preparations/paths.js";
import { prunePreparationRunLocked, sweepPreparationOrphansLocked } from "../../src/preparations/retention.js";
import { pruneUnitIdFor } from "../../src/preparations/prune-delete.js";
import { expect } from "vitest";
import { preparationManifestDigest } from "../../src/preparations/manifest-parse.js";
import { readPreparationKey } from "../../src/preparations/key-epoch.js";
import { preparationKeyFile, preparationPaths } from "../../src/preparations/paths.js";
import { preparationRunPredecessor } from "../../src/preparations/run-integrity.js";
import { appendPreparationTransitionLocked, readPreparationRun } from "../../src/preparations/run-store.js";
import { stagePreparationLocked } from "../../src/preparations/stage.js";
import type { PreparationManifestV1 } from "../../src/preparations/manifest-parse.js";
import type { PreparationRunBinding } from "../../src/preparations/run-types.js";
import { fixturePlan, stageRequest } from "./store-fixture.js";

const ACTOR: { id: string; surface: "cli" } = { id: "operator", surface: "cli" };

/** Stage one durable preparation and return its exact current run binding. */
export async function stagePreparation(root: string): Promise<{ binding: PreparationRunBinding; manifest: PreparationManifestV1 }> {
  // fallow-ignore-next-line code-duplication
  const staged = await stagePreparationLocked(root, stageRequest(fixturePlan()));
  if (staged.status !== "staged") throw new Error(`not staged: ${staged.status}`);
  const key = await readPreparationKey(root);
  if (key.status !== "ok") throw new Error("no preparation key");
  const binding: PreparationRunBinding = {
    runId: staged.manifest.runId, preparationId: staged.manifest.preparationId, workspaceId: staged.manifest.workspaceId,
    manifestDigest: preparationManifestDigest(staged.manifest), keyEpochId: key.keyEpochId,
  };
  return { binding, manifest: staged.manifest };
}

/** Append one authenticated driving transition from the current predecessor. */
// fallow-ignore-next-line code-duplication
async function drive(
  root: string, binding: PreparationRunBinding, type: string, stateAfter: string, payload: unknown, at: string,
): Promise<void> {
  const read = await readPreparationRun(root, binding);
  if (read.status !== "ok") throw new Error(`run ${read.status}`);
  await appendPreparationTransitionLocked(root, binding, preparationRunPredecessor(read.run), {
    type: type as never, stateAfter: stateAfter as never, actor: ACTOR, at, payload: payload as never,
  });
}

/** Drive a freshly staged run to a parked `recovery-required` state. */
export async function driveToRecoveryRequired(root: string, binding: PreparationRunBinding, at = "2026-07-20T00:01:00.000Z"): Promise<void> {
  await drive(root, binding, "recovery-required", "recovery-required", { kind: "problem", code: "preparation-integrity-obligation" }, at);
}

/** Drive a freshly staged run to a terminal `failed` state at a fixed instant. */
export async function driveToFailed(root: string, binding: PreparationRunBinding, at = "2026-05-01T00:00:00.000Z"): Promise<void> {
  await drive(root, binding, "failed", "failed", { kind: "none" }, at);
}

/** Flip one integrity nibble of the run leaf so it reads integrity-invalid. */
export async function tamperRun(root: string, binding: PreparationRunBinding): Promise<void> {
  const file = preparationPaths(root, binding.workspaceId).runFile(binding.runId);
  const record = JSON.parse(await readFile(file, "utf8")) as { integrity: string };
  record.integrity = `${record.integrity.slice(0, -1)}${record.integrity.endsWith("0") ? "1" : "0"}`;
  await writeFile(file, JSON.stringify(record), "utf8");
  const read = await readPreparationRun(root, binding);
  expect(read.status === "unavailable" && read.code).toBe("run-integrity-invalid");
}

/** Remove the project preparation key leaf entirely (a missing-key project). */
export async function removePreparationKey(root: string): Promise<void> {
  await rm(preparationKeyFile(root), { force: true });
  expect((await readPreparationKey(root)).status).toBe("absent");
}

/** Make the project preparation key leaf unreadable without removing it. */
export async function makePreparationKeyUnreadable(root: string): Promise<void> {
  await writeFile(preparationKeyFile(root), "not-a-valid-key", "utf8");
  expect((await readPreparationKey(root)).status).toBe("unavailable");
}

/** The principal every lifecycle fixture operation records. */
export const LIFECYCLE_ACTOR = ACTOR;

/** Require a real completed sweep, not merely a successful no-op. */
export async function expectCompletedSweep(root: string, at: string): Promise<void> {
  const swept = await sweepPreparationOrphansLocked(root, { actor: ACTOR, at, authorization: gateDecision("sweep") });
  expect(swept.status === "swept" && swept.receipt.kind).toBe("prune-completed");
}

/**
 * Crash a PRUNE after its plan is durable and return that unit's id.
 *
 * The sibling of {@link sweepStagedThenCrashed}, and the two together are the
 * state the per-unit owner rule exists for: one unit in each registry, or two in
 * the prune registry, so a rule quantified over the whole pending set refuses
 * every owner and strands both.
 *
 * IT CRASHES AT `afterPlanned`, NOT `afterStaged`, so the run leaf survives and
 * the caller can still resolve it. The staged variant is the harder case and has
 * its own fixture below, because a prune that has begun staging has already
 * destroyed the record a resume would otherwise be resolved from.
 */
export async function pruneStagedThenCrashed(root: string, at: string): Promise<{ runId: string; unitId: string }> {
  return stageAndCrashPrune(root, at, "afterPlanned");
}

/** Crash a prune AFTER its first object is staged: the run leaf is then gone. */
export async function pruneStagedBytesThenCrashed(root: string, at: string): Promise<{ runId: string; unitId: string }> {
  return stageAndCrashPrune(root, at, "afterStaged");
}

/**
 * Stage a prunable run and crash its prune at one named durable seam.
 *
 * WHICH SEAM IS THE WHOLE DIFFERENCE between the two helpers above, so it is the
 * only thing that varies: `afterPlanned` leaves the run leaf intact and its
 * binding resolvable, `afterStaged` has already destroyed it. Everything else —
 * the eligibility setup, the clock past the retention floor, the derived unit id
 * — is identical, and two copies of it would drift.
 */
export async function stageAndCrashPrune(
  root: string, at: string, seam: "afterPlanned" | "afterStaged" | "afterDeletes",
): Promise<{ runId: string; unitId: string; binding: PreparationRunBinding }> {
  const { binding } = await stagePreparation(root);
  await driveToFailed(root, binding);
  await expect(prunePreparationRunLocked(root, {
    authorization: gateDecision("prune", pruneUnitIdFor(binding.runId)),
        target: { kind: "run", binding }, actor: ACTOR, at,
    clock: { now: () => new Date("2026-07-01T00:00:00.000Z") },
    faults: { [seam]: async () => { throw new Error("crash"); } },
  })).rejects.toThrow("crash");
  return { runId: binding.runId, unitId: pruneUnitIdFor(binding.runId), binding };
}

/** Crash a sweep after its first object is staged and return that unit's id. */
export async function sweepStagedThenCrashed(root: string, at: string): Promise<string> {
  const { binding } = await stagePreparation(root);
  await rm(preparationPaths(root, binding.workspaceId).runFile(binding.runId), { force: true });
  await expect(sweepPreparationOrphansLocked(root, {
    actor: ACTOR, at, authorization: gateDecision("sweep"), faults: { afterStaged: async () => { throw new Error("crash"); } },
  })).rejects.toThrow("crash");
  const registry = path.join(root, ".llmwiki", PREPARATION_PRUNE_REGISTRY);
  const units = (await readdir(registry)).filter((entry) => entry.startsWith("swp-"));
  if (units.length !== 1) throw new Error(`expected one staged sweep unit, saw ${units.length}`);
  return units[0] as string;
}

/**
 * The gate decision a test is simulating, stated rather than implied.
 *
 * A test that drives the substrate directly holds no real ticket, but it is
 * still acting under SOME decision — a fresh start, or a resume of a named
 * unit — and the executor now re-evaluates that decision against its own
 * capture. Naming it here keeps each case honest about which one it exercises
 * instead of inheriting a default.
 */
export function gateDecision(
  intent: "prune" | "sweep" | "quarantine",
  targetUnitId?: string,
  ticketUnitId?: string,
): LifecycleAuthorizationV1 {
  const operation = intent === "prune" ? "run-prune" : intent === "sweep" ? "orphan-sweep" : "per-run-quarantine";
  return {
    intent,
    targetUnitId,
    ticket: ticketUnitId === undefined ? null : { operation, unitId: ticketUnitId },
  };
}

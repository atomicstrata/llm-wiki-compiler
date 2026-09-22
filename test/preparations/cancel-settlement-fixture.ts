/**
 * @file test/preparations/cancel-settlement-fixture.ts
 * @description Shared helpers for the cancellation-settlement suites. Every
 * helper here drives a REAL production writer — the lock-free advisory request,
 * the authenticated run reader, the project lock — so the suites can construct
 * their pending states without ever planting a record.
 */

import { acquireLock, releaseLock } from "../../src/utils/lock.js";
import { writePreparationCancelLockFree } from "../../src/preparations/cancellation.js";
import { readPreparationRun } from "../../src/preparations/run-store.js";
import {
  recordDurableCancellingLocked, settleCancelledRunLocked,
  type CancelSettlementInput, type CancelSettlementOutcomeV1,
} from "../../src/preparations/attempts/cancel-settlement.js";
import type { AttemptLegOutcomeV1 } from "../../src/preparations/attempts/types.js";
import type { PreparationRunV1 } from "../../src/preparations/run-types.js";
import { executePhaseAttempt } from "../../src/preparations/attempts/execute.js";
import type { AttemptOutcomeV1 } from "../../src/preparations/attempts/types.js";
import { attemptRequest, phaseInstanceIdFor, succeededLeg, type StagedPreparation } from "./attempt-fixture.js";

/** The operator principal every settlement in these suites records. */
export const OPERATOR = { id: "operator", surface: "cli" } as const;

/** The fixed advisory nonce; the request is create-only, so one per run suffices. */
const NONCE = "0".repeat(32);

const REQUESTED_AT = "2026-07-22T00:00:00.000Z";

/** Read the authenticated run or fail the test loudly. */
export async function readRun(staged: StagedPreparation): Promise<PreparationRunV1> {
  const read = await readPreparationRun(staged.root, staged.binding);
  if (read.status !== "ok") throw new Error(`run unavailable: ${read.status}`);
  return read.run;
}

/** Write the REAL lock-free operator cancel request for the staged run. */
export function requestCancel(staged: StagedPreparation): Promise<"created" | "exists"> {
  return writePreparationCancelLockFree(staged.root, {
    workspaceId: staged.binding.workspaceId, runId: staged.binding.runId,
    requester: "op", at: REQUESTED_AT, nonce: NONCE,
  });
}

/** The settlement inputs for one staged run, timestamped distinctly per call. */
export function settlementInput(staged: StagedPreparation, at = "2026-07-22T00:01:00.000Z"): CancelSettlementInput {
  return { root: staged.root, binding: staged.binding, principal: OPERATOR, at };
}

/** Run one action while holding the real project lock, as a lock holder would. */
export async function underLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  await acquireLock(root, { quiet: true });
  try {
    return await action();
  } finally {
    await releaseLock(root);
  }
}

/**
 * A leg that observes what the settlement decides WHILE the attempt that owns the
 * run is still in flight — the one window where the execution owner is live and
 * fencing. `setUp` runs first, under the same lock, for a suite that needs
 * durable state (an approved gate, a committed effect) in place before the
 * classification it wants to observe.
 *
 * The observation is returned by reference because the leg runs inside
 * `executePhaseAttempt`; the caller reads `.outcome` after the attempt returns.
 */
export function settlementProbeLeg(
  staged: () => StagedPreparation, setUp?: () => Promise<void>,
): { leg: () => Promise<AttemptLegOutcomeV1>; observed: { outcome?: CancelSettlementOutcomeV1 } } {
  const observed: { outcome?: CancelSettlementOutcomeV1 } = {};
  const leg = async () => {
    await underLock(staged().root, async () => {
      if (setUp !== undefined) await setUp();
      await recordDurableCancellingLocked(settlementInput(staged()));
      observed.outcome = await settleCancelledRunLocked(settlementInput(staged(), "2026-07-22T00:03:00.000Z"));
    });
    return succeededLeg();
  };
  return { leg, observed };
}

/**
 * Attempt a SIBLING phase of the staged run — the fixture plan's `expand`, which
 * no test drives directly. It is how a suite asks "is this run still startable",
 * since a run's own phase may be refused for phase-level reasons that say nothing
 * about the run's state.
 */
export function attemptSiblingPhase(staged: StagedPreparation): Promise<AttemptOutcomeV1> {
  return executePhaseAttempt(attemptRequest(staged, {
    logicalPhaseId: "expand", phaseInstanceId: phaseInstanceIdFor(staged.binding, "expand"),
  }));
}

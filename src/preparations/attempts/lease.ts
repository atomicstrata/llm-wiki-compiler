/**
 * @file src/preparations/attempts/lease.ts
 * @description Advisory attempt-lease fencing (design section 12.5). A lease is
 * PID plus process start time plus a random nonce — it is neither a lock nor a
 * grant and confers no write authority. PID liveness reuses the hardened,
 * PID-reuse-safe lock-owner primitives (`readProcessStartTime`/`isOwnerStale`)
 * rather than a weaker bare `process.kill` check. The nonce is the stale-result
 * fence: a cancelled, superseded, or recovered run rotates the recorded owner so
 * a late provider or host result cannot land under a nonce that no longer holds.
 */

import { randomBytes } from "node:crypto";
import { classifyOwnerLiveness, readProcessStartTime } from "../../utils/lock-owner.js";
import type { OwnerLiveness } from "../../utils/lock-owner.js";
import type { AttemptId } from "../ids.js";
import type { PreparationExecutionOwnerV1 } from "../run-types.js";
import type { AttemptLeaseV1 } from "./types.js";

/** Random-nonce entropy; wide enough that two live attempts never collide. */
const LEASE_NONCE_BYTES = 16;

/**
 * Mint a fresh lease for this process at `acquiredAt`. The process start time is
 * best-effort: when it cannot be read, liveness degrades to PID-only exactly as
 * the lock owner does, and the field is omitted so no reader treats "" as a real
 * identity.
 */
export function mintAttemptLease(acquiredAt: string): AttemptLeaseV1 {
  const startTime = readProcessStartTime(process.pid);
  const leaseNonce = randomBytes(LEASE_NONCE_BYTES).toString("hex");
  return startTime === null
    ? { pid: process.pid, leaseNonce, acquiredAt }
    : { pid: process.pid, processStartTime: startTime, leaseNonce, acquiredAt };
}

/** Project the durable execution-owner record for a sealed attempt intent. */
export function leaseExecutionOwner(lease: AttemptLeaseV1, attemptId: AttemptId): PreparationExecutionOwnerV1 {
  return {
    pid: lease.pid, leaseNonce: lease.leaseNonce, attemptId, acquiredAt: lease.acquiredAt,
    ...(lease.processStartTime === undefined ? {} : { processStartTime: lease.processStartTime }),
  };
}

/**
 * True only when a durable owner still names the sealed attempt AND lease nonce.
 * This is the leg-K stale-result fence: a rotated nonce (cancel/supersede/
 * recover) or a cleared owner fails the match so a late result cannot commit.
 */
export function ownerFencesAttempt(
  owner: PreparationExecutionOwnerV1 | undefined, attemptId: AttemptId, leaseNonce: string,
): boolean {
  return owner !== undefined && owner.attemptId === attemptId && owner.leaseNonce === leaseNonce;
}

/**
 * Classify a durable execution owner against the hardened, PID-reuse-safe
 * liveness evidence.
 *
 * ONE HOME for the owner-record-to-lock-owner shape, because two callers need it
 * and each building its own is how one comes to omit `processStartTime` and read
 * every owner as unidentifiable. A REPORTING surface needs the classification
 * itself: `stale` and `unobservable` are opposite things to tell an operator —
 * the attempt is gone and the run can be recovered, versus nothing here can say
 * whether it is gone, so recovery will refuse too.
 */
export function classifyExecutionOwnerLiveness(owner: Pick<PreparationExecutionOwnerV1, "pid" | "processStartTime">): OwnerLiveness {
  return classifyOwnerLiveness({
    pid: owner.pid,
    ...(owner.processStartTime === undefined ? {} : { startTime: owner.processStartTime }),
  });
}

/**
 * Decide whether a recorded owner's process is still live. A dead PID, or a
 * reused PID whose current start time differs from the recorded one, is not live.
 *
 * DERIVED from the classification rather than re-deriving it, so a caller acting
 * on the boolean and a caller reporting the evidence can never disagree about the
 * same owner. `unobservable` counts as live here, unchanged: that is the
 * fail-safe direction, since clearing a live executor's fence corrupts work.
 */
export function ownerProcessIsLive(owner: PreparationExecutionOwnerV1): boolean {
  return classifyExecutionOwnerLiveness(owner) !== "stale";
}

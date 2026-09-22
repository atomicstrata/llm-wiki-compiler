/**
 * @file src/operation-bundles/apply-owner.ts
 * @description The current process identity stamped into an `applying`/
 * `compensating` execution transition. The start time is approximated once at
 * module load from the process uptime, so it is stable within a process and
 * differs across a crash+restart even when the OS reuses the pid — the signal a
 * later stale-lock reclamation uses to tell a live owner from a dead one.
 */

import type { OperationApplyOwner } from "./run-types.js";

/** Best-effort process start time (ISO-8601), captured once at module load. */
const PROCESS_START_TIME = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();

/** The owner identity for the current process's in-flight execution. */
export function currentApplyOwner(): OperationApplyOwner {
  return { pid: process.pid, processStartTime: PROCESS_START_TIME };
}

/**
 * @file src/local-workflows/run-policy.ts
 * @description Execution-side run persistence. Passive reads retain their original exports.
 */
import { WorkflowRunIdError } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { randomBytes } from "node:crypto";
import { isSlugSafe } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { appendTerminalEvent } from "./events.js";
import { type WorkflowEvent, type WorkflowRun } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
/**
 * Number of random bytes whose hex suffixes a minted run id. 8 bytes → a 16-hex
 * suffix (64 bits of entropy), so a same-day birthday collision is negligible
 * even at very high run volumes. (A prior value of 2 → 16 bits made a collision —
 * which, without the no-clobber start, would OVERWRITE prior run history —
 * realistic at hundreds of runs/day.)
 */
const RUN_ID_RANDOM_BYTES = 8;


/**
 * Raised when {@link startWorkflow}'s no-clobber create keeps colliding with an
 * existing run id past {@link MAX_MINT_ATTEMPTS}. Astronomically unlikely with the
 * minted entropy; a typed error so a pathological environment surfaces rather than
 * looping or silently overwriting prior run history.
 */
export class WorkflowRunIdCollisionError extends Error {
  constructor(attempts: number) {
    super(`could not mint a non-colliding workflow run id after ${attempts} attempts`);
    this.name = "WorkflowRunIdCollisionError";
  }
}


/**
 * Mint an opaque, slug-safe run id of the form `<workflowId>-<YYYY-MM-DD>-<rand>`.
 *
 * The date is today's `toISOString().slice(0,10)` and `rand` is the hex of
 * {@link RUN_ID_RANDOM_BYTES} random bytes from `node:crypto` (a 16-hex suffix).
 * Date/randomness are fine here — this is product code, not a workflow script. The
 * result is asserted slug-safe before returning; a non-slug-safe `workflowId`
 * cannot legitimately reach here (the profile validator rejects it) but the
 * assertion is a defensive floor.
 *
 * @param workflowId - The slug-safe id of the workflow being run.
 * @returns A slug-safe run id prefixed with `workflowId`.
 * @throws {WorkflowRunIdError} If the composed id is not slug-safe.
 */
export function mintRunId(workflowId: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const rand = randomBytes(RUN_ID_RANDOM_BYTES).toString("hex");
  const runId = `${workflowId}-${date}-${rand}`;
  if (!isSlugSafe(runId)) {
    throw new WorkflowRunIdError(`composed id is not slug-safe: ${JSON.stringify(runId)}`);
  }
  return runId;
}


/**
 * Return a minimized copy of a TERMINAL run that drops the large caller-controlled
 * `inputs`/`outputs`/verifier-receipt blobs (terminal evidence is historical),
 * keeping status/runId/digests/stageLog/events. A `fields-truncated` marker is
 * appended via {@link appendTerminalEvent} so the loss is auditable, never silent.
 * The marker append also compacts the event trail if needed, so the result is
 * smaller on both axes. NOTE: this does NOT shrink a record dominated by a
 * NON-clearable field (`stageLog`/`knownStageIds`/`events`); {@link terminalTombstone}
 * is the guaranteed-minimal last resort for that case.
 */
function minimizeTerminalRun(run: WorkflowRun): WorkflowRun {
  const at = new Date().toISOString();
  const { verifierReceipts: _receipts, ...withoutReceipts } = run;
  const cleared: WorkflowRun = { ...withoutReceipts, inputs: {}, outputs: {} };
  return appendTerminalEvent(cleared, {
    type: "fields-truncated", at, actorKind: "system",
    detail: _receipts === undefined
      ? "inputs/outputs cleared to fit the run byte cap on termination"
      : "inputs/outputs/verifier receipts cleared to fit the run byte cap on termination",
  });
}


/** The marker detail recorded when a terminal run is reduced to a tombstone. */
const TOMBSTONE_DETAIL =
  "stageLog/knownStageIds/satisfiedGates/inputs/outputs and prior events dropped to fit the byte cap on termination";


/**
 * Return a GUARANTEED-minimal terminal TOMBSTONE for `run` — the last-resort that
 * cannot breach the byte cap. Keeps only the bounded identity/lifecycle fields
 * (`runId` ≤ 128 chars, the 64-hex digests, the short status/timestamps) and
 * EMPTIES every unbounded array (`stageLog`/`knownStageIds`/`satisfiedGates`) and
 * blob (`inputs`/`outputs`). The `events` trail is reduced to the genesis
 * `workflow-start` (kept if present, else a synthetic minimal one) plus ONE
 * `fields-truncated` marker noting the drop, so the audit degrades gracefully and
 * never silently. Every retained field has a bounded size, so the serialized
 * tombstone is a few hundred bytes << {@link MAX_WORKFLOW_RUN_BYTES} — the terminal
 * write provably fits. The run stays terminal, so it re-reads `ok` and classifies
 * `historical`.
 */
function terminalTombstone(run: WorkflowRun): WorkflowRun {
  const at = new Date().toISOString();
  const genesis = run.events.find((e) => e.type === "workflow-start")
    ?? { type: "workflow-start" as const, at: run.startedAt, actorKind: "system" as const, stateVersionBefore: 0, stateVersionAfter: 0 };
  const marker: WorkflowEvent = {
    type: "fields-truncated", at, actorKind: "system", detail: TOMBSTONE_DETAIL,
    stateVersionBefore: run.stateVersion, stateVersionAfter: run.stateVersion + 1,
  };
  const tombstone: WorkflowRun = {
    schemaVersion: run.schemaVersion, runId: run.runId, workflowId: run.workflowId,
    workflowDigest: run.workflowDigest, profileDigest: run.profileDigest,
    status: run.status, currentStage: null, stateVersion: run.stateVersion + 1,
    startedAt: run.startedAt, updatedAt: at,
    stageLog: [], knownStageIds: [], satisfiedGates: [], inputs: {}, outputs: {},
    events: [genesis, marker],
  };
  return {
    ...tombstone,
    ...(run.processAuthority === undefined ? {} : { processAuthority: run.processAuthority }),
    ...(run.refusal === undefined ? {} : { refusal: run.refusal }),
  };
}


/** Yield progressively smaller terminal records; core signs and measures actual persisted bytes. */
export function* terminalRunCandidates(run: WorkflowRun): Generator<WorkflowRun> {
  yield run;
  yield minimizeTerminalRun(run);
  yield terminalTombstone(run);
}

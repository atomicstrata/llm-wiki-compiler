/**
 * @file src/local-workflows/start-operation.ts
 * @description The `start` operation: mint a new run of a declared workflow.
 *
 * `start` is the ONLY operation here, and it is deliberately minimal: under the
 * project lock, it loads the active profile, looks up the requested workflow,
 * mints a run id, builds a fresh `pending` {@link WorkflowRun} pinned to the
 * def/profile it was started against (for later drift detection), and persists
 * it through the confined store. It does NO stage execution, evaluates NO gates,
 * performs NO writes into `wiki/`, and appends NO event log — those belong to a
 * later slice. The run simply enters its first stage as `pending`.
 *
 * The lock is acquired BOUNDED-BLOCKING (a transiently-busy project RETRIES, then
 * throws {@link LockBusyError} on timeout — the consistent workflow-op contract)
 * and ALWAYS released in `finally`, mirroring the recover-command pattern.
 */

import type { BlockingLockOptions } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { LocalWorkflowHost } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { workflowDefDigest } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { mintRunId, WorkflowRunIdCollisionError } from "./run-policy.js";
import { isTerminalStatus } from "./with-lock.js";
import { lookupWorkflowDef } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { currentActorIdentity } from "./actor-identity.js";
import { snapshotWorkflowInputs } from "./input-snapshot.js";
import { MAX_MINT_ATTEMPTS, MAX_ACTIVE_WORKFLOW_RUNS, MAX_TOTAL_WORKFLOW_RUNS } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { WORKFLOW_RUN_SCHEMA_VERSION, type WorkflowRun } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { WorkflowDef } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { WorkflowProcessAuthorityV1 } from "@atomicstrata/llmwiki-core/local-workflow-contracts";

/** Raised when a workflow id is not declared in the active profile. */
export class UnknownWorkflowError extends Error {
  constructor(workflowId: string) {
    super(`unknown workflow: ${JSON.stringify(workflowId)} is not declared in the active profile`);
    this.name = "UnknownWorkflowError";
  }
}

/**
 * Raised when a project is at or above the active-run cap
 * ({@link MAX_ACTIVE_WORKFLOW_RUNS}) or the total run-FILE cap
 * ({@link MAX_TOTAL_WORKFLOW_RUNS}) when another `start` is attempted (H5). Fail
 * closed: nothing is minted, so an unbounded-`start` DoS is capped — the active cap
 * bounds in-flight runs (retiring one frees quota) and the total cap bounds the
 * on-disk run-file count (so a start+cancel LOOP leaving terminal files behind is
 * also bounded).
 */
export class TooManyActiveRunsError extends Error {
  constructor(
    /** The breaching count at the point of refusal. */
    readonly count: number,
    /** Which cap was breached: the active-run cap or the total run-file cap. */
    readonly cap: "active" | "total" = "active",
  ) {
    super(
      cap === "total"
        ? `too many workflow run files: ${count} total runs at or above the cap of ${MAX_TOTAL_WORKFLOW_RUNS}`
        : `too many active workflow runs: ${count} active runs at or above the cap of ${MAX_ACTIVE_WORKFLOW_RUNS}`,
    );
    this.name = "TooManyActiveRunsError";
  }
}

/**
 * Raised when the run store cannot be ENUMERATED at `start` so the run quota cannot
 * be verified (H5). Fail CLOSED: an unenumerable store (escape/readdir failure) must
 * REFUSE the start rather than bypass the quota — a broken store can never be a
 * licence to mint unbounded runs.
 */
export class WorkflowRunStoreUnavailableError extends Error {
  constructor(
    /** The store's `unavailable` detail. */
    readonly detail: string,
  ) {
    super(`cannot verify the workflow run quota: the run store is unavailable (${detail})`);
    this.name = "WorkflowRunStoreUnavailableError";
  }
}

/**
 * Count how many of `runIds` name an ACTIVE run, reading each fail-closed and
 * counting an UNREADABLE leaf CONSERVATIVELY as active. A corrupt / HMAC-failed /
 * legacy-unsigned leaf cannot be verified, so it must NOT create quota room (a
 * fail-OPEN that would let a single mangled leaf bypass the active cap); counting it
 * as active also avoids hard-blocking ALL new starts on one bad leaf (which a
 * fail-CLOSED "refuse if any leaf is unreadable" policy would do). An `ok` terminal
 * run is the only thing that frees a slot.
 */
async function countActiveAmong(host: LocalWorkflowHost, root: string, runIds: string[]): Promise<number> {
  let active = 0;
  for (const runId of runIds) {
    const read = await host.history.read(root, runId);
    if (read.status === "unavailable") active++; // unverifiable → count toward the quota, never free room
    else if (read.status === "ok" && !isTerminalStatus(read.run.status)) active++;
  }
  return active;
}

/**
 * Fail closed BEFORE a new run is minted (H5) when the project is at either run cap.
 * Enumerates the store ONCE: an UNENUMERABLE store throws
 * {@link WorkflowRunStoreUnavailableError} (fail closed — never bypass the quota); a
 * TOTAL run-file count at/above {@link MAX_TOTAL_WORKFLOW_RUNS}, or an ACTIVE
 * (non-terminal) count at/above {@link MAX_ACTIVE_WORKFLOW_RUNS}, throws
 * {@link TooManyActiveRunsError}. Runs under the held project lock so the
 * check-then-mint is race-free.
 *
 * @param root - Absolute project root.
 * @throws {WorkflowRunStoreUnavailableError} When the store cannot be enumerated.
 * @throws {TooManyActiveRunsError} When the total or active cap is reached.
 */
async function assertRunQuota(host: LocalWorkflowHost, root: string): Promise<void> {
  const list = await host.history.list(root);
  if (list.status !== "ok") throw new WorkflowRunStoreUnavailableError(list.detail);
  if (list.runIds.length >= MAX_TOTAL_WORKFLOW_RUNS) throw new TooManyActiveRunsError(list.runIds.length, "total");
  const active = await countActiveAmong(host, root, list.runIds);
  if (active >= MAX_ACTIVE_WORKFLOW_RUNS) throw new TooManyActiveRunsError(active, "active");
}

/**
 * Mint a run id that does NOT collide with an existing run, retrying a bounded
 * number of times. The caller holds the project lock, so this check-then-use is
 * race-free against other lock holders: no concurrent start can plant the id
 * between the {@link runExists} probe and the subsequent no-clobber write. A
 * persistent collision (astronomically unlikely with the minted entropy) surfaces
 * as {@link WorkflowRunIdCollisionError} rather than overwriting prior history.
 *
 * @param root - Absolute project root (the caller holds its lock).
 * @param workflowId - The workflow whose run id is being minted.
 * @param mint - Id generator seam (defaults to {@link mintRunId}; injectable for tests).
 * @returns A run id confirmed absent on disk.
 * @throws {WorkflowRunIdCollisionError} When every attempt collides.
 */
async function mintFreshRunId(
  host: LocalWorkflowHost,
  root: string,
  workflowId: string,
  mint: (workflowId: string) => string,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt++) {
    const candidate = mint(workflowId);
    if (!(await host.history.exists(root, candidate))) return candidate;
  }
  throw new WorkflowRunIdCollisionError(MAX_MINT_ATTEMPTS);
}

/**
 * Build the fresh `pending` run record for a just-started workflow.
 *
 * Pins `workflowDigest`/`profileDigest`/`knownStageIds` to the def/profile the
 * run starts against (drift detection), enters the first stage as the
 * `currentStage` (with a defensive `?? null` even though the validator
 * guarantees ≥1 stage), and seeds every stage's log entry as `pending`.
 *
 * The run is born at `stateVersion` 0 with a single genesis `workflow-start`
 * event (before/after both 0 — the start records the birth, it does not advance
 * state) and no satisfied gates yet. Records the starting caller's advisory `owner`
 * identity ({@link currentActorIdentity}) for the M1 ownership check.
 */
function buildPendingRun(args: {
  runId: string;
  workflowId: string;
  def: WorkflowDef;
  profileDigest: string;
  inputs: Record<string, unknown>;
  processAuthority?: WorkflowProcessAuthorityV1;
}): WorkflowRun {
  const now = new Date().toISOString();
  const stageIds = args.def.stages.map((stage) => stage.id);
  const run: WorkflowRun = {
    schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
    runId: args.runId,
    workflowId: args.workflowId,
    workflowDigest: workflowDefDigest(args.def),
    profileDigest: args.profileDigest,
    knownStageIds: stageIds,
    status: "pending",
    currentStage: stageIds[0] ?? null,
    stageLog: stageIds.map((stageId) => ({ stageId, status: "pending" })),
    inputs: args.inputs,
    outputs: {},
    owner: currentActorIdentity(),
    stateVersion: 0,
    startedAt: now,
    updatedAt: now,
    events: [{ type: "workflow-start", at: now, actorKind: "system", stateVersionBefore: 0, stateVersionAfter: 0 }],
    satisfiedGates: [],
  };
  return args.processAuthority === undefined ? run : { ...run, processAuthority: args.processAuthority };
}

/**
 * Start a new run of a declared workflow.
 *
 * Acquires the project lock BOUNDED-BLOCKING (a transiently-busy lock retries,
 * then throws {@link LockBusyError} on timeout) and ALWAYS releases it. Under the
 * lock: loads the active profile, looks up `workflowId` (throws
 * {@link UnknownWorkflowError} when undeclared, writing nothing), mints a run id,
 * builds the `pending` run, and persists it. Does NO stage work and appends NO event.
 *
 * The run id is minted NO-CLOBBER: under the held lock it is re-minted until it
 * names an absent run, so a (vanishingly rare) id collision can never overwrite
 * prior run history. Caller `inputs` are depth- AND size-bounded BEFORE the record
 * is built ({@link snapshotWorkflowInputs}), so a deeply-nested SDK start
 * input is rejected before the stringify rather than overflowing the stack.
 *
 * @param root - Absolute project root.
 * @param workflowId - The declared workflow to start.
 * @param inputs - Caller-supplied inputs recorded on the run (size-capped).
 * @param mintId - Id generator seam (defaults to {@link mintRunId}; injectable for tests).
 * @param lockOptions - Bounded-blocking acquire overrides (timeout/poll interval).
 * @returns The persisted run record.
 * @throws {LockBusyError} When the lock stays held past the bounded timeout.
 * @throws {UnknownWorkflowError} When `workflowId` is not declared in the profile.
 * @throws {WorkflowRunStoreUnavailableError} When the store can't be enumerated to verify the quota (H5).
 * @throws {TooManyActiveRunsError} When the project is at the active or total run cap (H5).
 * @throws {WorkflowInputsTooLargeError} When `inputs` exceed the size cap.
 * @throws {WorkflowInputBoundsError} When `inputs` nest past the depth cap (SDK start path).
 * @throws {WorkflowRunIdCollisionError} When a non-colliding id cannot be minted.
 */
export async function startWorkflowWithHost(
  host: LocalWorkflowHost,
  request: StartWorkflowRequest,
): Promise<WorkflowRun> {
  const { root, workflowId, mintId = mintRunId, lockOptions = {} } = request;
  const captured = snapshotWorkflowInputs(request.inputs);
  const processOptions = {
    workspaceId: request.processOptions?.workspaceId,
    required: request.processOptions?.required === true,
  };
  return host.withMutation(root, transaction => startWorkflowWithServices({
    host, root, persist: run => host.records.write(transaction, root, run),
  }, workflowId, captured, mintId, processOptions), lockOptions);
}

/**
 * Start a run while the caller already holds the project lock.
 * This narrow seam lets a product atomically bind a predecessor reservation to
 * successor creation without manufacturing workflow state.
 */
export async function startWorkflowWithServices(
  services: StartServices, workflowId: string, inputs: Record<string, unknown>,
  mintId: (workflowId: string) => string = mintRunId,
  processOptions: { workspaceId?: string; required?: boolean } = {},
): Promise<WorkflowRun> {
  const { host, root, persist } = services;
  const captured = snapshotWorkflowInputs(inputs);
  const loaded = await host.profiles.load(root);
  const def = lookupWorkflowDef(loaded.profile.workflows, workflowId);
  if (def === undefined) throw new UnknownWorkflowError(workflowId);
  const processAuthority = await host.profiles.resolveProcessAuthority(
    root, processOptions.workspaceId, processOptions.required === true,
  );
  await assertRunQuota(host, root);
  const run = buildPendingRun({
    runId: await mintFreshRunId(host, root, workflowId, mintId), workflowId, def,
    profileDigest: loaded.digest, inputs: captured, processAuthority,
  });
  await persist(run);
  return run;
}


/** Immutable start request captured before acquiring the project lock. */
export interface StartWorkflowRequest {
  root: string;
  workflowId: string;
  inputs: Record<string, unknown>;
  mintId?: (workflowId: string) => string;
  lockOptions?: BlockingLockOptions;
  processOptions?: { workspaceId?: string; required?: boolean };
}

/** Internal algorithm dependencies; composition explicitly chooses the locked write path. */
export interface StartServices {
  host: LocalWorkflowHost;
  root: string;
  persist(run: WorkflowRun): Promise<void>;
}

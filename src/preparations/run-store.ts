/**
 * @file src/preparations/run-store.ts
 * @description Exact-binding preparation-run reads, create-only genesis
 * publication, and authenticated-prefix transition appends with whole-file
 * fsync/rename replacement (design sections 12.1, 12.2, 13). No exported writer
 * accepts a caller-supplied progressed record or re-signs unverifiable history:
 * every append re-reads and authenticates the exact predecessor, appends exactly
 * one next state version through the pure hash-chained constructor, re-parses and
 * re-verifies the candidate in memory, charges the correct budget lane, and only
 * then durably replaces the record. Handoff and abandonment run through dedicated
 * writers that verify their evidence before the state changes.
 */

import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import { atomicWrite } from "../utils/atomic-write.js";
import { authenticatedRunRead, publishRunGenesis } from "../utils/run-store-io.js";
import { readDurableOperationLeaf } from "../operation-bundles/durable-leaf.js";
import { MAX_PREPARATION_RUN_BYTES } from "./constants.js";
import { readPreparationEvidence } from "./evidence-store.js";
import { readPreparationKey } from "./key-epoch.js";
import { preparationPaths } from "./paths.js";
import { assertPreparationRunWriteBudget, preparationRunWriteBudgetClass, projectPreparationRunBudget, type RunBudgetInput, type RunWriteBudgetClass } from "./run-budget.js";
import {
  appendPreparationTransition, createInitialPreparationRun, preparationRunBinding,
  preparationRunBindingMatches, preparationRunPredecessor, signPreparationRun,
  verifyPreparationRunIntegrity,
} from "./run-integrity.js";
import { parsePreparationRun } from "./run-parse.js";
import type {
  AppendPreparationTransitionInput, HandoffBindingV1, HandoffStartBindingV1,
  InitialPreparationRunInput, PreparationPrincipalV1, PreparationRunBinding,
  PreparationRunContentV1, PreparationRunPredecessor, PreparationRunV1, ResidualFindingV1,
} from "./run-types.js";

/**
 * Typed reason an authenticated run read could not be trusted. Following the
 * inherited Milestone A taxonomy (PO-INV-31), integrity-invalid is folded into
 * `unavailable` rather than a fourth status, but every leg carries a distinct
 * typed `code` so a Task 3 consumer branches on the code — never a free-form
 * `detail` string. `run-integrity-invalid` is the "bytes exist but are not
 * trusted under the healthy key" case (design section 25.2); the two key legs
 * stay distinct from a missing/unreadable leaf and from a bad identity.
 */
export type PreparationRunUnavailableCode =
  | "identity"
  | "run-leaf-unavailable"
  | "integrity-key-missing"
  | "integrity-key-unreadable"
  | "run-integrity-invalid";

export type PreparationRunRead =
  | { status: "ok"; run: PreparationRunV1 }
  | { status: "absent" }
  | { status: "unavailable"; detail: string; code: PreparationRunUnavailableCode };

/** Explicit residual-state confirmation and its verified findings. */
export interface AbandonPreparationRunInput {
  actor: PreparationPrincipalV1;
  at: string;
  confirmResidualState: true;
  findings: readonly ResidualFindingV1[];
}

/** The reserved-identity binding recorded when a handoff durably begins. */
export interface HandoffStartInput {
  actor: PreparationPrincipalV1;
  at: string;
  start: HandoffStartBindingV1;
}

/** The actor/timestamp settling a handoff; every identity comes from durable state. */
export interface HandoffPreparationRunInput {
  actor: PreparationPrincipalV1;
  at: string;
}

/** Read one exact workspace run leaf before consulting any project key. */
async function readRunLeaf(root: string, binding: PreparationRunBinding) {
  const paths = preparationPaths(root, binding.workspaceId);
  return readDurableOperationLeaf(root, paths.runFile(binding.runId), paths.runsRoot, MAX_PREPARATION_RUN_BYTES);
}

/** Read, parse, and authenticate only against all caller-requested identities. */
export async function readPreparationRun(root: string, binding: PreparationRunBinding): Promise<PreparationRunRead> {
  let leaf: Awaited<ReturnType<typeof readRunLeaf>>;
  try {
    leaf = await readRunLeaf(root, binding);
  } catch {
    return { status: "unavailable", detail: "identity", code: "identity" };
  }
  if (leaf.kind === "absent") return { status: "absent" };
  if (leaf.kind === "unavailable") return { status: "unavailable", detail: "run-leaf", code: "run-leaf-unavailable" };
  const key = await readPreparationKey(root);
  if (key.status === "absent") return { status: "unavailable", detail: "key-missing", code: "integrity-key-missing" };
  if (key.status === "unavailable") return { status: "unavailable", detail: "key-unreadable", code: "integrity-key-unreadable" };
  return authenticatedRunRead(() => parsePreparationRun(leaf.body, binding),
    (run) => verifyPreparationRunIntegrity(run, key.key, binding));
}

/** Sign, serialize, parse, and authenticate a candidate before touching disk. */
function prepareSignedRun(
  run: PreparationRunContentV1, key: Buffer, binding: PreparationRunBinding, budgetClass: RunWriteBudgetClass,
): { parsed: PreparationRunV1; serialized: string } {
  const signed = signPreparationRun(key, run);
  const serialized = canonicalBytes(signed).toString("utf8");
  assertPreparationRunWriteBudget(Buffer.byteLength(serialized, "utf8"), budgetClass);
  const parsed = parsePreparationRun(serialized, binding);
  if (!verifyPreparationRunIntegrity(parsed, key, binding)) throw new Error("preparation run HMAC verification failed");
  return { parsed, serialized };
}

/** Require one healthy current key without ever creating or replacing it. */
async function requirePreparationKey(root: string) {
  const key = await readPreparationKey(root);
  if (key.status === "absent") throw new Error("preparation integrity key is missing");
  if (key.status === "unavailable") throw new Error("preparation integrity key is unreadable");
  return key;
}

/**
 * Publish the sole genesis record without replacement. The caller holds the
 * project lock and has already completed manifest/evidence preflight. The
 * declared plan budget is re-proven so no run defect can follow a durable write.
 */
export async function createPreparationRunLocked(
  root: string, input: InitialPreparationRunInput, budgetInput: RunBudgetInput,
): Promise<PreparationRunV1> {
  projectPreparationRunBudget(budgetInput);
  const key = await requirePreparationKey(root);
  if (input.keyEpochId !== key.keyEpochId) throw new Error("preparation run key epoch mismatch");
  const content = createInitialPreparationRun(input), binding = preparationRunBinding(content);
  const prepared = prepareSignedRun(content, key.key, binding, "ordinary");
  const file = preparationPaths(root, binding.workspaceId).runFile(binding.runId);
  await publishRunGenesis({ root, file }, prepared.serialized, async () => {
    const collision = await readPreparationRun(root, binding);
    return `preparation run genesis already exists: ${collision.status}`;
  });
  return prepared.parsed;
}

/** Refuse stale callers unless both state version and chain tip are exact. */
function assertExpectedPredecessor(run: PreparationRunV1, expected: PreparationRunPredecessor): void {
  const actual = preparationRunPredecessor(run);
  if (actual.stateVersion !== expected.stateVersion || actual.chainTip !== expected.chainTip) {
    throw new Error("preparation run predecessor changed");
  }
}

/**
 * A pure projector layering additive attempt facts (execution owner, phase
 * summaries, evidence/effect summaries) onto the base next-state content Task 4
 * needs. It never alters the state, state version, or transition chain: the
 * caller-independent invariant check below re-runs on the projected content so a
 * tampering projector fails closed before the record is signed or written.
 */
export type PreparationRunContentProjector = (
  next: PreparationRunContentV1,
) => PreparationRunContentV1;

/** Append one already-proof-checked transition to an authenticated exact prefix. */
async function appendAuthenticatedTransition(
  root: string, binding: PreparationRunBinding, expected: PreparationRunPredecessor,
  input: AppendPreparationTransitionInput, project?: PreparationRunContentProjector,
): Promise<PreparationRunV1> {
  const read = await readPreparationRun(root, binding);
  if (read.status !== "ok") throw new Error(`preparation run unavailable: ${read.status === "unavailable" ? read.detail : read.status}`);
  assertExpectedPredecessor(read.run, expected);
  if (!preparationRunBindingMatches(read.run, binding)) throw new Error("preparation run binding mismatch");
  const key = await requirePreparationKey(root);
  if (key.keyEpochId !== binding.keyEpochId) throw new Error("preparation run key epoch changed");
  const base = appendPreparationTransition(read.run, input);
  const next = project ? project(base) : base;
  if (next.stateVersion !== expected.stateVersion + 1 || next.transitions.length !== read.run.transitions.length + 1
    || next.state !== base.state) {
    throw new Error("preparation run append did not produce exactly one next state version");
  }
  const prepared = prepareSignedRun(next, key.key, binding, preparationRunWriteBudgetClass(input.type));
  await atomicWrite(preparationPaths(root, binding.workspaceId).runFile(binding.runId), prepared.serialized, {
    confineRoot: root, exactParent: true, durable: true, strictDurability: true, mode: 0o600,
  });
  return prepared.parsed;
}

/**
 * Append one attempt transition that additionally projects execution-owner,
 * phase-summary, and evidence/effect facts onto the run (design sections 12.5,
 * 13.2). Task 4 supplies the pure projector; the shared under-lock predecessor
 * authentication, budget lane, re-parse, and re-verify guarantee no attempt
 * projection can bypass the run's integrity contract.
 */
export function appendProjectedTransitionLocked(
  root: string, binding: PreparationRunBinding, expected: PreparationRunPredecessor,
  input: AppendPreparationTransitionInput, project: PreparationRunContentProjector,
): Promise<PreparationRunV1> {
  if (input.type === "handed-off" || input.type === "abandoned") {
    throw new Error(`${input.type} requires its evidence-verifying control writer`);
  }
  return appendAuthenticatedTransition(root, binding, expected, input, project);
}

/** Append one ordinary or fixed-shape control transition under the project lock. */
export async function appendPreparationTransitionLocked(
  root: string, binding: PreparationRunBinding, expected: PreparationRunPredecessor,
  input: AppendPreparationTransitionInput,
): Promise<PreparationRunV1> {
  if (input.type === "handed-off" || input.type === "abandoned") {
    throw new Error(`${input.type} requires its evidence-verifying control writer`);
  }
  return appendAuthenticatedTransition(root, binding, expected, input);
}

/** Append the reserved-lane park move to `recovery-required`. */
export function appendHeadroomExhaustedControl(
  root: string, binding: PreparationRunBinding, expected: PreparationRunPredecessor,
  actor: PreparationPrincipalV1, at: string,
): Promise<PreparationRunV1> {
  return appendAuthenticatedTransition(root, binding, expected, {
    type: "headroom-exhausted", stateAfter: "recovery-required", actor, at,
    payload: { kind: "problem", code: "preparation-run-headroom-exhausted" },
  });
}

/**
 * Durably record `handoff-started`: the reserved-identity recovery authority
 * (design section 22.3 step 6). It writes ONLY the exact reserved bundle/run
 * identities, the deterministic bundle-manifest digest, the pre-handoff chain tip,
 * and the origin/evidence-copy digests through the shared authenticated append —
 * no Milestone A bundle exists yet. On crash this transition is the sole authority
 * that lets recovery resume the same creation rather than mint a duplicate.
 */
export function appendHandoffStartedTransitionLocked(
  root: string, binding: PreparationRunBinding, expected: PreparationRunPredecessor,
  input: HandoffStartInput,
): Promise<PreparationRunV1> {
  return appendAuthenticatedTransition(root, binding, expected, {
    type: "handoff-started", stateAfter: "handoff-started", actor: input.actor, at: input.at,
    payload: { kind: "handoff-started", ...input.start },
  });
}

/** Extract the durable reserved-identity authority from the run's own history. */
export function handoffStartBinding(run: PreparationRunV1): HandoffStartBindingV1 | undefined {
  for (let index = run.transitions.length - 1; index >= 0; index--) {
    const payload = run.transitions[index]!.payload;
    if (payload.kind === "handoff-started") {
      const { kind: _kind, ...start } = payload;
      return start;
    }
  }
  return undefined;
}

/**
 * Settle a handoff by binding the reserved bundle identity recorded at
 * `handoff-started` to the run. The bundle id, manifest digest, handoff id, and
 * pre-handoff hash are read from the DURABLE handoff-started transition — never
 * from the caller — so a `handed-off` binding can only name the exact bundle the
 * recovery authority reserved, and its handoff id recomputes from the same
 * pre-handoff chain tip the loader re-derives on every read.
 */
export async function appendHandoffTransitionLocked(
  root: string, binding: PreparationRunBinding, expected: PreparationRunPredecessor,
  input: HandoffPreparationRunInput,
): Promise<PreparationRunV1> {
  const read = await readPreparationRun(root, binding);
  if (read.status !== "ok") throw new Error(`preparation run unavailable: ${read.status}`);
  const start = handoffStartBinding(read.run);
  if (start === undefined) throw new Error("handed-off requires a prior handoff-started transition");
  const handoff: HandoffBindingV1 = {
    handoffId: start.handoffId, bundleId: start.reservedBundleId,
    bundleManifestDigest: start.bundleManifestDigest, finalTransitionHash: start.preHandoffTransitionHash,
  };
  return appendAuthenticatedTransition(root, binding, expected, {
    type: "handed-off", stateAfter: "handed-off", actor: input.actor, at: input.at, handoff,
    payload: { kind: "handoff", handoffId: start.handoffId, bundleManifestDigest: start.bundleManifestDigest },
  });
}

/** Verify every residual finding's evidence before the abandonment transition. */
async function verifyResidualEvidence(
  root: string, binding: PreparationRunBinding, findings: readonly ResidualFindingV1[],
): Promise<void> {
  for (const finding of findings) {
    if (finding.evidence === undefined) continue;
    const read = await readPreparationEvidence(
      root, { workspaceId: binding.workspaceId, preparationId: binding.preparationId },
      finding.evidence.digest.slice("sha256:".length),
    );
    if (read.status !== "ok" || read.byteCount !== finding.evidence.byteCount) {
      throw new Error("preparation abandonment evidence is unavailable or mismatched");
    }
  }
}

/** Require explicit confirmation and verified fresh evidence before abandonment. */
export async function appendAbandonedTransitionLocked(
  root: string, binding: PreparationRunBinding, expected: PreparationRunPredecessor,
  input: AbandonPreparationRunInput,
): Promise<PreparationRunV1> {
  if (input.confirmResidualState !== true) throw new Error("residual-state confirmation is required");
  await verifyResidualEvidence(root, binding, input.findings);
  return appendAuthenticatedTransition(root, binding, expected, {
    type: "abandoned", stateAfter: "abandoned", actor: input.actor, at: input.at,
    residualFindings: input.findings,
    payload: { kind: "abandonment", confirmation: "confirm-residual-state", findingCount: input.findings.length },
  });
}

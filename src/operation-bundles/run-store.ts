/**
 * @file src/operation-bundles/run-store.ts
 * @description Exact-binding operation-run reads, create-only genesis
 * publication, and authenticated-prefix transition appends. No exported writer
 * accepts a caller-supplied progressed record or re-signs unverifiable history.
 */

import { createHash } from "node:crypto";
import { canonicalBytes, canonicalDigest } from "../profile/templates/signing/canonical.js";
import { atomicWrite } from "../utils/atomic-write.js";
import { authenticatedRunRead, publishRunGenesis } from "../utils/run-store-io.js";
import { readConfinedLeafBuffer } from "../utils/confined-read.js";
import { MAX_MUTATIONS_PER_BUNDLE, MAX_RUN_BYTES, MAX_RUN_EVIDENCE_BLOB_BYTES } from "./constants.js";
import { mutationId, type MutationId } from "./ids.js";
import { readDurableOperationLeaf } from "./durable-leaf.js";
import { readOperationKey } from "./key-epoch.js";
import { operationPaths } from "./paths.js";
import type { OperationProblemCode } from "./problems.js";
import { assertOperationRunWriteBudget, operationRunWriteBudgetClass, projectRunBudget, type RunWriteBudgetClass } from "./run-budget.js";
import {
  appendOperationTransition, createInitialOperationRun, operationRunBinding,
  operationRunBindingMatches, operationRunPredecessor, signOperationRun,
  verifyOperationRunIntegrity,
} from "./run-integrity.js";
import { parseAbandonmentObservation, parseOperationRun } from "./run-parse.js";
import {
  authoritativeNamespaceForMutation, residualFindingsDigest,
  unresolvedResidualIds,
} from "./run-residuals.js";
import type {
  AppendOperationTransitionInput, InitialOperationRunInput, OperationRun,
  OperationRunBinding, OperationRunPredecessor,
  ResidualFinding, RunEvidenceRef,
} from "./run-types.js";
import type { OperationPrincipal } from "./principal.js";
import type { OperationBundleManifest } from "./types.js";

export type OperationRunRead =
  | { status: "ok"; run: OperationRun }
  | { status: "absent" }
  | { status: "unavailable"; detail: string; code?: OperationProblemCode };

export interface RecoveryRequiredControlTransition {
  type: "recovery-required";
  code: "run-record-headroom-exhausted";
  actor: OperationPrincipal;
  at: string;
}

/** Proof inputs for settling an original from an authenticated recovery run. */
export interface RecoveredControlTransition {
  actor: OperationPrincipal;
  at: string;
  recoveryBinding: OperationRunBinding;
  recoveryExpected: OperationRunPredecessor;
  recoveryManifest: OperationBundleManifest;
}

/** Explicit destructive confirmation and bounded fresh residual observations. */
export interface AbandonmentObservation {
  code: string;
  mutationId: MutationId;
  evidence: RunEvidenceRef;
}

/** Explicit destructive confirmation and bounded fresh residual observations. */
export interface AbandonedControlTransition {
  actor: OperationPrincipal;
  at: string;
  confirmResidualState: true;
  manifest: OperationBundleManifest;
  observations: readonly AbandonmentObservation[];
}

/** Read one exact workspace leaf before consulting any project key. */
async function readRunLeaf(root: string, binding: OperationRunBinding) {
  const paths = operationPaths(root, binding.workspaceId);
  return readDurableOperationLeaf(
    root, paths.runFile(binding.runId), paths.runsRoot, MAX_RUN_BYTES,
  );
}

/** Read, parse, and authenticate only against all caller-requested identities. */
export async function readOperationRun(root: string, binding: OperationRunBinding): Promise<OperationRunRead> {
  let leaf: Awaited<ReturnType<typeof readRunLeaf>>;
  try {
    leaf = await readRunLeaf(root, binding);
  } catch {
    return { status: "unavailable", detail: "identity" };
  }
  if (leaf.kind === "absent") return { status: "absent" };
  if (leaf.kind === "unavailable") return { status: "unavailable", detail: "run-leaf" };
  const key = await readOperationKey(root);
  if (key.status === "absent") return { status: "unavailable", detail: "key-missing", code: "integrity-key-missing" };
  if (key.status === "unavailable") return { status: "unavailable", detail: "key-unreadable", code: "integrity-key-unreadable" };
  return authenticatedRunRead(() => parseOperationRun(leaf.body, binding),
    (run) => verifyOperationRunIntegrity(run, key.key, binding));
}

/** Sign, serialize, parse, and authenticate a candidate before touching disk. */
function prepareSignedRun(run: ReturnType<typeof createInitialOperationRun>, key: Buffer, binding: OperationRunBinding, budgetClass: RunWriteBudgetClass): { parsed: OperationRun; serialized: string } {
  const signed = signOperationRun(key, run);
  const serialized = canonicalBytes(signed).toString("utf8");
  assertOperationRunWriteBudget(Buffer.byteLength(serialized, "utf8"), budgetClass);
  const parsed = parseOperationRun(serialized, binding);
  if (!verifyOperationRunIntegrity(parsed, key, binding)) throw new Error("operation run HMAC verification failed");
  return { parsed, serialized };
}

/** Prove the complete worst case before create-only genesis publication. */
function preflightGenesis(input: InitialOperationRunInput): void {
  const projections = input.manifest.mutations.filter((item) => item.kind === "projection").length;
  projectRunBudget({
    mutationCount: input.manifest.mutations.length - projections,
    declaredCompensatorCount: input.declaredCompensatorMutationIds.length,
    projectionCount: projections,
    controlTransitionAllowance: input.controlTransitionAllowance,
  });
}

/**
 * Publish the sole genesis record without replacement. The caller must hold the
 * project lock and must already have completed manifest/payload preflight.
 */
export async function createOperationRunLocked(root: string, input: InitialOperationRunInput): Promise<OperationRun> {
  preflightGenesis(input);
  const key = await requireOperationKey(root);
  if (input.keyEpochId !== key.keyEpochId) throw new Error("operation run key epoch mismatch");
  const content = createInitialOperationRun(input), binding = operationRunBinding(content);
  const prepared = prepareSignedRun(content, key.key, binding, "ordinary");
  const file = operationPaths(root, binding.workspaceId).runFile(binding.runId);
  await publishRunGenesis({ root, file }, prepared.serialized, async () => {
    const collision = await readOperationRun(root, binding);
    return `operation run genesis already exists: ${collision.status}`;
  });
  return prepared.parsed;
}

/** Require one healthy current key without ever creating or replacing it. */
async function requireOperationKey(root: string) {
  const key = await readOperationKey(root);
  if (key.status === "absent") throw new Error("integrity-key-missing");
  if (key.status === "unavailable") throw new Error("integrity-key-unreadable");
  return key;
}

/** Refuse stale callers unless both state version and chain tip are exact. */
function assertExpectedPredecessor(run: OperationRun, expected: OperationRunPredecessor): void {
  const actual = operationRunPredecessor(run);
  if (actual.stateVersion !== expected.stateVersion || actual.chainTip !== expected.chainTip) {
    throw new Error("operation run predecessor changed");
  }
}

/**
 * Authenticate the exact predecessor, append exactly one next state version,
 * and durably replace the record. The caller must hold the project lock.
 */
export async function appendOperationTransitionLocked(
  root: string,
  binding: OperationRunBinding,
  expected: OperationRunPredecessor,
  input: AppendOperationTransitionInput,
): Promise<OperationRun> {
  if (input.type === "recovered" || input.type === "abandoned") {
    throw new Error(`${input.type} requires its evidence-verifying control writer`);
  }
  return appendAuthenticatedTransition(root, binding, expected, input);
}

/** Append one already-proof-checked transition to an authenticated exact prefix. */
async function appendAuthenticatedTransition(
  root: string,
  binding: OperationRunBinding,
  expected: OperationRunPredecessor,
  input: AppendOperationTransitionInput,
): Promise<OperationRun> {
  const read = await readOperationRun(root, binding);
  if (read.status !== "ok") throw new Error(`operation run unavailable: ${read.status === "unavailable" ? read.detail : read.status}`);
  assertExpectedPredecessor(read.run, expected);
  if (!operationRunBindingMatches(read.run, binding)) throw new Error("operation run binding mismatch");
  const key = await requireOperationKey(root);
  if (key.keyEpochId !== binding.keyEpochId) throw new Error("operation run key epoch changed");
  const next = appendOperationTransition(read.run, input);
  if (next.stateVersion !== expected.stateVersion + 1 || next.transitions.length !== read.run.transitions.length + 1) {
    throw new Error("operation run append did not produce exactly one next state version");
  }
  const prepared = prepareSignedRun(next, key.key, binding, operationRunWriteBudgetClass(input.type));
  await atomicWrite(operationPaths(root, binding.workspaceId).runFile(binding.runId), prepared.serialized, {
    confineRoot: root, exactParent: true, durable: true, strictDurability: true, mode: 0o600,
  });
  return prepared.parsed;
}

/** Append the fixed reserve-lane park move with an explicit current actor. */
export function appendControlTransition(
  root: string,
  binding: OperationRunBinding,
  expected: OperationRunPredecessor,
  input: RecoveryRequiredControlTransition,
): Promise<OperationRun> {
  return appendOperationTransitionLocked(root, binding, expected, {
    type: input.type, stateAfter: "recovery-required", actor: input.actor, at: input.at,
    payload: { kind: "problem", code: input.code },
  });
}

/** Verify the referenced recovery run is currently successful before settlement. */
export async function appendRecoveredTransitionLocked(
  root: string,
  binding: OperationRunBinding,
  expected: OperationRunPredecessor,
  input: RecoveredControlTransition,
): Promise<OperationRun> {
  if (input.recoveryBinding.workspaceId !== binding.workspaceId || input.recoveryBinding.keyEpochId !== binding.keyEpochId
    || input.recoveryBinding.bundleId === binding.bundleId || input.recoveryBinding.runId === binding.runId) {
    throw new Error("recovery run binding does not settle this workspace epoch");
  }
  const manifest = input.recoveryManifest;
  if (manifest.bundleId !== input.recoveryBinding.bundleId || manifest.runId !== input.recoveryBinding.runId
    || manifest.workspaceId !== binding.workspaceId || manifest.recoversBundleId !== binding.bundleId
    || canonicalDigest(manifest) !== input.recoveryBinding.manifestDigest) {
    throw new Error("recovery manifest is not bound to the original bundle");
  }
  const recovery = await readOperationRun(root, input.recoveryBinding);
  if (recovery.status !== "ok") throw new Error("recovery run is unavailable");
  assertExpectedPredecessor(recovery.run, input.recoveryExpected);
  if (recovery.run.state !== "succeeded" && recovery.run.state !== "succeeded-with-warnings" && recovery.run.state !== "compensated") {
    throw new Error("recovery run has not reached successful terminal settlement");
  }
  return appendAuthenticatedTransition(root, binding, expected, {
    type: "recovered", stateAfter: "recovered", actor: input.actor, at: input.at,
    payload: { kind: "recovery", bundleId: recovery.run.bundleId, runId: recovery.run.runId,
      manifestDigest: recovery.run.manifestDigest, terminalState: recovery.run.state,
      stateVersion: recovery.run.stateVersion, chainTip: operationRunPredecessor(recovery.run).chainTip },
  });
}

/** Verify the exact manifest named by the authenticated run binding. */
function assertAbandonmentManifest(binding: OperationRunBinding, manifest: OperationBundleManifest): void {
  if (manifest.bundleId !== binding.bundleId || manifest.runId !== binding.runId
    || manifest.workspaceId !== binding.workspaceId || canonicalDigest(manifest) !== binding.manifestDigest) {
    throw new Error("abandonment manifest does not match the run binding digest");
  }
  manifest.mutations.forEach((item, index) => {
    if (item.index !== index || item.mutationId !== mutationId(manifest.bundleId, index)) {
      throw new Error("abandonment manifest mutation identity mismatch");
    }
  });
}

/** Build findings in exact unresolved order with manifest-derived namespaces. */
function buildResidualFindings(
  unresolved: readonly MutationId[],
  manifest: OperationBundleManifest,
  observations: readonly AbandonmentObservation[],
): ResidualFinding[] {
  const byId = new Map<MutationId, AbandonmentObservation>();
  for (const observation of observations) {
    if (byId.has(observation.mutationId)) throw new Error("abandonment observations contain duplicate coverage");
    byId.set(observation.mutationId, observation);
  }
  if (byId.size !== unresolved.length || unresolved.some((id) => !byId.has(id))) {
    throw new Error("abandonment observations do not exactly cover unresolved work");
  }
  const mutations = new Map(manifest.mutations.map((item) => [item.mutationId, item]));
  return unresolved.map((id) => {
    const observation = byId.get(id)!, mutation = mutations.get(id);
    if (mutation === undefined) throw new Error("abandonment observation is not manifest-owned");
    return { ...observation, authoritativeNamespace: authoritativeNamespaceForMutation(mutation), evidence: { ...observation.evidence } };
  });
}

/** Verify one claimed evidence reference against exact confined raw bytes. */
async function verifyResidualEvidence(root: string, binding: OperationRunBinding, evidence: RunEvidenceRef): Promise<void> {
  const match = /^sha256:([0-9a-f]{64})$/.exec(evidence.digest);
  if (match === null || !Number.isSafeInteger(evidence.byteCount) || evidence.byteCount > MAX_RUN_EVIDENCE_BLOB_BYTES) {
    throw new Error("run evidence reference is invalid");
  }
  const paths = operationPaths(root, binding.workspaceId);
  const read = await readConfinedLeafBuffer(
    root, paths.evidenceFile(binding.runId, match[1]!),
    paths.evidenceRoot(binding.runId), MAX_RUN_EVIDENCE_BLOB_BYTES,
    { requireSingleLink: true },
  );
  if (read.kind !== "ok") throw new Error(`run evidence is ${read.kind}`);
  const digest = `sha256:${createHash("sha256").update(read.body).digest("hex")}`;
  if (read.body.byteLength !== evidence.byteCount || digest !== evidence.digest) {
    throw new Error("run evidence byte count or digest mismatch");
  }
}

/** Require explicit confirmation, fresh evidence, and manifest-owned namespaces. */
export async function appendAbandonedTransitionLocked(
  root: string,
  binding: OperationRunBinding,
  expected: OperationRunPredecessor,
  input: AbandonedControlTransition,
): Promise<OperationRun> {
  if (!input.actor.grants.includes("operation-bundle.abandon")) throw new Error("operation-bundle.abandon grant is required");
  if (input.confirmResidualState !== true) throw new Error("residual-state confirmation is required");
  if (input.observations.length > MAX_MUTATIONS_PER_BUNDLE) {
    throw new Error(`abandonment observations exceed the ${MAX_MUTATIONS_PER_BUNDLE}-mutation launch bound`);
  }
  const read = await readOperationRun(root, binding);
  if (read.status !== "ok") throw new Error("operation run is unavailable for abandonment");
  assertExpectedPredecessor(read.run, expected);
  const unresolved = unresolvedResidualIds(read.run);
  if (input.observations.length !== unresolved.length) throw new Error("abandonment observations do not exactly cover unresolved work count");
  const observations = input.observations.map(parseAbandonmentObservation);
  assertAbandonmentManifest(binding, input.manifest);
  const findings = buildResidualFindings(unresolved, input.manifest, observations);
  for (const finding of findings) await verifyResidualEvidence(root, binding, finding.evidence!);
  return appendAuthenticatedTransition(root, binding, expected, {
    type: "abandoned", stateAfter: "abandoned", actor: input.actor, at: input.at,
    residualFindings: findings,
    payload: {
      kind: "abandonment", confirmation: "confirm-residual-state",
      findingCount: findings.length, findingsDigest: residualFindingsDigest(findings),
    },
  });
}

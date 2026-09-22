/**
 * @file src/operation-bundles/recovery-plan.ts
 * @description Separately-reviewed recovery-bundle planning. A parked
 * (recovery-required, integrity-valid) original run, its exact manifest digest,
 * the approve grant, and bounded closed action input authorize a core host
 * planner to compile changed intent into an ordinary immutable bundle. The draft
 * flows through the SAME manifest validator and staging transaction as every
 * other bundle (no privileged recovery mutation kind), with recoversBundleId set
 * to the original and the recovery graph edges validated by staging. The original
 * remains recovery-required until the recovery bundle reaches an accepted terminal
 * state, at which point it receives a durable `recovered` transition through the
 * Foundation writer appendRecoveredTransitionLocked.
 */

import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import { parseBoundedUniqueJson } from "../profile/templates/signing/json.js";
import type { OperationActionResult } from "./executor.js";
import { runResult } from "./executor.js";
import type { BundleId } from "./ids.js";
import { readOperationKey } from "./key-epoch.js";
import { operationManifestDigest } from "./manifest-parse.js";
import { readOperationManifest } from "./manifest-store.js";
import { operationPaths } from "./paths.js";
import type { OperationPrincipal } from "./principal.js";
import type { OperationProblemCode } from "./problems.js";
import { operationRunPredecessor } from "./run-integrity.js";
import { appendRecoveredTransitionLocked, readOperationRun } from "./run-store.js";
import type { OperationRun, OperationRunBinding } from "./run-types.js";
import { stageOperationBundleLocked, type OperationBundleDraft, type OperationMutationDraft, type OperationRunDraft, type StageOperationBundleResult } from "./stage.js";
import type { OperationBundleManifest, OperationDigest } from "./types.js";

const MAX_ACTION_INPUT_BYTES = 16 * 1024;

/** The request to plan a reviewed recovery bundle for a parked original run. */
export interface RecoveryPlanRequest {
  workspaceId: string;
  originalBundleId: BundleId;
  originalManifestDigest: OperationDigest;
  principal: OperationPrincipal;
  actionInput: Readonly<Record<string, unknown>>;
}

/** The bounded, closed context a core host planner receives. */
export interface RecoveryPlanContext {
  workspaceId: string;
  originalBundleId: BundleId;
  originalManifest: OperationBundleManifest;
  originalRun: OperationRun;
  actionInput: Readonly<Record<string, unknown>>;
}

/** The bounded draft a core host planner returns (ordinary typed mutations only). */
export interface RecoveryDraft {
  mutations: readonly OperationMutationDraft[];
  payloads: ReadonlyMap<string, Buffer>;
  run: OperationRunDraft;
}

/** A core-known host planner: a typed function, never manifest-supplied code. */
export interface HostRecoveryPlanner {
  planRecovery(context: RecoveryPlanContext): Promise<RecoveryDraft>;
}

/** Typed refusal carrying a stable problem code for a recovery-plan authority failure. */
export class RecoveryPlanError extends Error {
  constructor(readonly code: OperationProblemCode, message: string) {
    super(message);
    this.name = "RecoveryPlanError";
  }
}

/** Re-validate action input as bounded closed data (no functions, size-capped). */
function boundedActionInput(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new RecoveryPlanError("review-item-invalid", "recovery action input must be a closed object");
  }
  let bytes: Buffer;
  try { bytes = canonicalBytes(input); } catch { throw new RecoveryPlanError("review-item-invalid", "recovery action input is not closed data"); }
  if (bytes.byteLength > MAX_ACTION_INPUT_BYTES) throw new RecoveryPlanError("review-item-invalid", "recovery action input exceeds its cap");
  return parseBoundedUniqueJson(bytes.toString("utf8"), MAX_ACTION_INPUT_BYTES) as Readonly<Record<string, unknown>>;
}

/** Load and validate the original manifest by exact digest + workspace. */
async function loadOriginalManifest(root: string, workspaceId: string, bundleId: BundleId, manifestDigest: OperationDigest): Promise<OperationBundleManifest> {
  const manifestRead = await readOperationManifest(root, workspaceId, bundleId);
  if (manifestRead.status === "absent") throw new RecoveryPlanError("review-item-not-found", "original bundle not found");
  if (manifestRead.status !== "ok") throw new RecoveryPlanError("review-store-unavailable", "original bundle unavailable");
  const manifest = manifestRead.manifest;
  if (operationManifestDigest(manifest) !== manifestDigest) throw new RecoveryPlanError("review-digest-mismatch", "original manifest digest mismatch");
  if (manifest.workspaceId !== workspaceId) throw new RecoveryPlanError("review-item-invalid", "original workspace mismatch");
  return manifest;
}

/** Load a run + its binding + manifest by exact digest, failing closed with typed codes. */
async function loadOriginalRun(root: string, workspaceId: string, bundleId: BundleId, manifestDigest: OperationDigest): Promise<{ run: OperationRun; binding: OperationRunBinding; manifest: OperationBundleManifest }> {
  const manifest = await loadOriginalManifest(root, workspaceId, bundleId, manifestDigest);
  const key = await readOperationKey(root);
  if (key.status === "absent") throw new RecoveryPlanError("integrity-key-missing", "operation key missing");
  if (key.status === "unavailable") throw new RecoveryPlanError("integrity-key-unreadable", "operation key unreadable");
  const binding: OperationRunBinding = { runId: manifest.runId, bundleId, manifestDigest, workspaceId, keyEpochId: key.keyEpochId };
  const runRead = await readOperationRun(root, binding);
  if (runRead.status !== "ok") throw new RecoveryPlanError(runRead.status === "absent" ? "review-item-not-found" : runRead.code ?? "run-integrity-invalid", "original run is not integrity-valid");
  return { run: runRead.run, binding, manifest };
}

/** Build the ordinary bundle draft that stages the recovery bundle. */
function recoveryBundleDraft(request: RecoveryPlanRequest, original: OperationBundleManifest, draft: RecoveryDraft): OperationBundleDraft {
  return {
    workspaceId: original.workspaceId, createdBy: request.principal.id,
    knowledgeAuthority: original.knowledgeAuthority, operationsAuthority: original.operationsAuthority,
    grantDigest: original.grantDigest, safetyFloorDigest: original.safetyFloorDigest,
    inputs: [], preparationEvidence: [], bounds: [...original.bounds],
    completeness: { attempted: 0, completed: 0, skipped: 0, failed: 0, requiredMissing: 0, optionalMissing: 0, rationaleDigest: original.completeness.rationaleDigest },
    reconciliations: [], planningWarnings: [], recoversBundleId: request.originalBundleId,
    mutations: [...draft.mutations], run: draft.run,
  };
}

/**
 * Plan a reviewed recovery bundle for a parked original run. The result is an
 * ordinary bundle left awaiting-approval; approval + apply run through the same
 * executor as any other bundle. The caller holds the project lock.
 */
export async function planRecoveryBundleLocked(root: string, request: RecoveryPlanRequest, planner: HostRecoveryPlanner): Promise<StageOperationBundleResult> {
  if (!request.principal.grants.includes("operation-bundle.approve")) {
    throw new RecoveryPlanError("approval-grant-missing", "recovery planning requires the approve grant");
  }
  const original = await loadOriginalRun(root, request.workspaceId, request.originalBundleId, request.originalManifestDigest);
  if (original.run.state !== "recovery-required") {
    throw new RecoveryPlanError("bundle-recovery-required", "original run is not recovery-required");
  }
  const actionInput = boundedActionInput(request.actionInput);
  const draft = await planner.planRecovery({
    workspaceId: request.workspaceId, originalBundleId: request.originalBundleId,
    originalManifest: original.manifest, originalRun: original.run, actionInput,
  });
  return stageOperationBundleLocked(root, { draft: recoveryBundleDraft(request, original.manifest, draft), payloads: draft.payloads });
}

/** The request to settle a parked original from its accepted recovery bundle. */
export interface RecoverySettlementRequest {
  workspaceId: string;
  originalBundleId: BundleId;
  originalManifestDigest: OperationDigest;
  recoveryBundleId: BundleId;
  recoveryManifestDigest: OperationDigest;
  principal: OperationPrincipal;
  at: string;
}

/** Terminal recovery states that are allowed to settle an original run. */
const RECOVERY_SUCCESS_STATES = new Set(["succeeded", "succeeded-with-warnings", "compensated"]);

/**
 * Settle a parked original run from its recovery bundle. When the recovery run
 * has reached an accepted terminal state the original receives a durable
 * `recovered` transition (via the Foundation writer, which re-verifies the
 * recovery run's success and manifest binding); otherwise the original is left
 * parked at recovery-required.
 */
export async function settleOriginalFromRecoveryLocked(root: string, request: RecoverySettlementRequest): Promise<OperationActionResult> {
  const original = await loadOriginalRun(root, request.workspaceId, request.originalBundleId, request.originalManifestDigest);
  if (original.run.state !== "recovery-required") return runResult(original.run);
  const recovery = await loadOriginalRun(root, request.workspaceId, request.recoveryBundleId, request.recoveryManifestDigest);
  if (!RECOVERY_SUCCESS_STATES.has(recovery.run.state)) return runResult(original.run, "bundle-recovery-required");
  const settled = await appendRecoveredTransitionLocked(root, original.binding, operationRunPredecessor(original.run), {
    actor: request.principal, at: request.at, recoveryBinding: recovery.binding,
    recoveryExpected: operationRunPredecessor(recovery.run), recoveryManifest: recovery.manifest,
  });
  return runResult(settled);
}

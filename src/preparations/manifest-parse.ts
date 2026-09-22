/**
 * @file src/preparations/manifest-parse.ts
 * @description Bounded, duplicate-key-free loader for the immutable version-one
 * preparation manifest (design section 13.1). It rebuilds an allowlisted record,
 * re-runs the closed normalized-plan loader, recomputes and re-verifies the
 * plan digest, binds the initial input evidence to the plan's declared input
 * set, and rejects a self-referential supersession. Cross-manifest supersession
 * resolution (cycles, dangling, cross-workspace, required-fork) belongs to the
 * manifest graph validator, which sees the whole workspace set.
 *
 * EVERY REJECTION LEAVES THIS LOADER AS A TYPED PREPARATION PROBLEM so that the
 * PRE-PUBLICATION call site — `materializeManifest` in `stage.ts`, which
 * re-parses the candidate before anything is written — can hand a caller a
 * refusal rather than a fault. That is a statement about that one call site, not
 * about the loader in the abstract: the write path in `manifest-store.ts`
 * re-parses the SAME text after evidence is already durable, and deliberately
 * strips the type back off. See `asManifestProblem`.
 */

import { canonicalBytes, canonicalDigest } from "../profile/templates/signing/canonical.js";
import { parseBoundedUniqueJson } from "../profile/templates/signing/json.js";
import { array, exact, record, unique } from "../operation-bundles/manifest-values.js";
import { MAX_PREPARATION_MANIFEST_BYTES, MAX_PREPARED_INPUTS_PER_RUN } from "./constants.js";
import { assertPreparationId, assertPreparationRunId, type PreparationId, type PreparationRunId } from "./ids.js";
import { assertWorkspaceId } from "./paths.js";
import { evidenceRef } from "./plan-parse-helpers.js";
import { parsePreparationPlan, verifyPreparationPlanDigest } from "./plan-parse.js";
import { canonicalTime, parsePrincipal, runDigest } from "./run-parse-helpers.js";
import { PREPARATION_VALIDATION_PROBLEMS, PreparationPlanError } from "./problems.js";
import type { NormalizedPreparationPlanV1 } from "./plan-types.js";
import type { JsonRecord } from "../operation-bundles/manifest-values.js";
import type { PreparationPrincipalV1 } from "./run-types.js";
import type { EvidenceRefV1, Sha256Digest } from "./types.js";

const TOP_KEYS = [
  "schemaVersion", "preparationId", "runId", "workspaceId", "createdAt",
  "createdBy", "keyEpochId", "plan", "planDigest", "initialEvidence",
] as const;
const TOP_OPTIONAL = ["supersedesPreparationId"] as const;

/** The immutable version-one preparation manifest (design section 13.1). */
export interface PreparationManifestV1 {
  schemaVersion: 1;
  preparationId: PreparationId;
  runId: PreparationRunId;
  workspaceId: string;
  createdAt: string;
  createdBy: PreparationPrincipalV1;
  keyEpochId: Sha256Digest;
  plan: NormalizedPreparationPlanV1;
  planDigest: Sha256Digest;
  initialEvidence: EvidenceRefV1[];
  supersedesPreparationId?: PreparationId;
}

/** Return the manifest's canonical digest (never self-stored; the run records it). */
export function preparationManifestDigest(manifest: PreparationManifestV1): Sha256Digest {
  return canonicalDigest(manifest) as Sha256Digest;
}

/**
 * Retype this loader's UNTYPED rejections as the domain's plan-validation problem.
 *
 * WHY THE WHOLE LOADER AND NOT THE ONE OVER-CAP LINE. `materializeManifest` in
 * `stage.ts` builds a candidate manifest and re-parses it here BEFORE anything
 * is written, so a rejection at that call site means nothing happened — which is
 * what the service's refusal allowlist promises a caller. But the shared value
 * readers this loader is built from (`parseBoundedUniqueJson`, `record`,
 * `exact`, `array`, `unique`, and the field parsers under `evidenceRef`) belong
 * to the operation-bundle grammar and raise a bare `Error`, which that allowlist
 * rethrows as a FAULT.
 *
 * `initialEvidence` is the one manifest field a staging caller sizes and fills —
 * every other field is host-minted or copied from an already-validated plan —
 * and it escaped that way in three distinct shapes: over the item cap, over the
 * manifest byte cap once the refs carry long labels, and per-ref on any bounded
 * string or closed enum. Typing only the item cap would have MOVED the escape
 * rather than closed it, so the invariant gets one home here and every reader
 * built from those primitives inherits it.
 *
 * THIS IS NOT A PROPERTY OF THE LOADER, IT IS A PROPERTY OF THAT CALL SITE. The
 * write path re-parses the same text from `manifest-store.ts` AFTER the initial
 * evidence is durably materialized; a rejection there is a host defect arriving
 * too late to be a refusal, and that module strips the type back off rather than
 * report `refused` over bytes already on disk.
 *
 * `PREPARATION_VALIDATION_PROBLEMS` already name their own dimension or identity
 * kind and pass through untouched. The message is preserved verbatim — it names
 * the offending field and carries no host path — and the original throw rides
 * along as `cause`.
 */
function asManifestProblem<T>(load: () => T): T {
  try {
    return load();
  } catch (error) {
    if (PREPARATION_VALIDATION_PROBLEMS.some((problem) => error instanceof problem)) throw error;
    throw new PreparationPlanError(
      error instanceof Error ? error.message : "preparation manifest is invalid", { cause: error });
  }
}

/** Rebuild and validate one complete version-one preparation manifest. */
export function parsePreparationManifest(text: string): PreparationManifestV1 {
  return asManifestProblem(() => {
    const root = record(parseBoundedUniqueJson(text, MAX_PREPARATION_MANIFEST_BYTES), "preparation manifest");
    exact(root, TOP_KEYS, TOP_OPTIONAL);
    if (root.schemaVersion !== 1) throw new PreparationPlanError("preparation manifest schemaVersion must be 1");
    const manifest = rebuildManifest(root);
    bindManifest(manifest);
    return manifest;
  });
}

/** Rebuild the manifest fields, re-running the closed plan loader. */
function rebuildManifest(root: JsonRecord): PreparationManifestV1 {
  const plan = parsePreparationPlan(canonicalBytes(record(root.plan, "manifest plan")).toString("utf8"));
  const preparationId = assertPreparationId(root.preparationId);
  const supersedesPreparationId = root.supersedesPreparationId === undefined
    ? undefined : assertPreparationId(root.supersedesPreparationId);
  if (supersedesPreparationId === preparationId) throw new PreparationPlanError("preparation manifest supersedes itself");
  return {
    schemaVersion: 1, preparationId, runId: assertPreparationRunId(root.runId),
    workspaceId: assertWorkspaceId(root.workspaceId), createdAt: canonicalTime(root.createdAt, "manifest createdAt"),
    createdBy: parsePrincipal(root.createdBy), keyEpochId: runDigest(root.keyEpochId, "manifest keyEpochId"),
    plan, planDigest: runDigest(root.planDigest, "manifest planDigest"),
    initialEvidence: unique(array(root.initialEvidence, "initialEvidence", MAX_PREPARED_INPUTS_PER_RUN)
      .map((item, index) => evidenceRef(item, `initialEvidence[${index}]`)), "digest", "initialEvidence"),
    ...(supersedesPreparationId === undefined ? {} : { supersedesPreparationId }),
  };
}

/** Verify the plan digest, workspace binding, and initial-input coverage. */
function bindManifest(manifest: PreparationManifestV1): void {
  verifyPreparationPlanDigest(manifest.plan, manifest.planDigest);
  if (manifest.plan.workspaceId !== manifest.workspaceId) {
    throw new PreparationPlanError("preparation manifest workspace does not match its plan");
  }
  const initialInputDigest = manifest.plan.initialInputSet.digest;
  if (!manifest.initialEvidence.some((evidence) => evidence.digest === initialInputDigest)) {
    throw new PreparationPlanError("preparation manifest initial evidence omits the plan input set");
  }
  if (manifest.plan.supersedesPreparationId !== undefined
    && manifest.plan.supersedesPreparationId !== manifest.supersedesPreparationId) {
    throw new PreparationPlanError("preparation manifest supersession disagrees with its plan");
  }
}

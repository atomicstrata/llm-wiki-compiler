/**
 * @file src/artifacts/execution-provenance.ts
 * @description The write-time EXECUTION-PROVENANCE verifier — the optional arm of an
 * artifact-existence precondition (`ArtifactPreconditionReq.executionProvenance`)
 * that requires the pinned artifact's BYTES to have been admitted as provider
 * output of a real, settled preparation run. Invoked from the same
 * gated-state-entry authority as the health check (`./enforce-precondition.ts`),
 * never a second enforcement home.
 *
 * WHAT IT COMPARES: the pinned artifact digest against the ADMITTED EVIDENCE of a
 * run whose sealed plan carries the declared action id, whose frozen input names
 * this entity's slug under the declared field, and whose terminal state is EXACTLY
 * `succeeded` — never cancelled, abandoned, or failed. The matching evidence ref
 * must be `kind=provider-output` under the declared output id (its
 * `provenanceLabel`) with a provider producer, which is how admission records
 * attempt correlation. "Any admitted digest" would be TOO BROAD: an initial-input
 * ref or an unrelated provider artifact must never vouch for a result.
 *
 * FAIL CLOSED, with the deny/park split the sibling health check already speaks:
 * a store problem, a truncated scan, or an unreadable sealed input is "could not
 * verify" (park), never a pass and never silently narrowed to "no such run"
 * (deny). Only a clean scan with no vouching run denies.
 *
 * GENERIC BY CONSTRUCTION: this module speaks action ids, input fields, and
 * provider output ids — the plan's own vocabulary — and knows nothing about any
 * product's entities. The store reads are injectable (`ExecutionProvenanceStoreV1`)
 * so every conjunct can be witnessed against synthetic runs; production binds
 * the real preparation store.
 */

import { scanPreparationInventory } from "../preparations/capacity.js";
import type { PreparationManifestV1 } from "../preparations/manifest-parse.js";
import {
  readPreparationInitialInput, resolvePreparationRun,
  type PreparationInitialInputLookupV1, type PreparationRunLookupV1,
} from "../preparations/service-run-lookup.js";
import type { ExecutionProvenanceReq } from "../profile/types.js";

/** The three-way outcome, matching the health check's deny/park vocabulary. */
export interface ExecutionProvenanceVerdictV1 {
  readonly verdict: "pass" | "deny" | "park";
  readonly detail: string;
}

/** The store reads the verifier depends on — the real preparation store in production. */
export interface ExecutionProvenanceStoreV1 {
  scanInventory(root: string): Promise<{ manifests: readonly PreparationManifestV1[]; problems: readonly unknown[] }>;
  readInitialInput(root: string, manifest: PreparationManifestV1): Promise<PreparationInitialInputLookupV1>;
  resolveRun(root: string, runId: string): Promise<PreparationRunLookupV1>;
}

/** The production binding: the authenticated preparation store's own readers. */
const PREPARATION_STORE: ExecutionProvenanceStoreV1 = {
  scanInventory: (root) => scanPreparationInventory(root),
  readInitialInput: (root, manifest) => readPreparationInitialInput(root, manifest),
  resolveRun: (root, runId) => resolvePreparationRun(root, runId as never),
};

/** One candidate's contribution: it vouches, it was unreadable, or it is out. */
type CandidateOutcome = "vouches" | "unreadable" | "no-match";

/** Whether one candidate run vouches for the pinned digest (see file overview). */
async function candidateOutcome(
  store: ExecutionProvenanceStoreV1, root: string, manifest: PreparationManifestV1,
  req: ExecutionProvenanceReq, slug: string, pinnedDigest: string,
): Promise<CandidateOutcome> {
  const input = await store.readInitialInput(root, manifest);
  if (!input.ok) return "unreadable";
  if (input.record[req.slugInputField] !== slug) return "no-match";
  const resolved = await store.resolveRun(root, manifest.runId);
  if (!resolved.ok) return resolved.failure === "unavailable" ? "unreadable" : "no-match";
  if (resolved.run.state !== "succeeded") return "no-match";
  const vouches = resolved.run.evidenceRefs.some((ref) =>
    ref.kind === "provider-output"
    && ref.provenanceLabel === req.resultOutputId
    && ref.producer.kind === "provider"
    && ref.digest === pinnedDigest);
  return vouches ? "vouches" : "no-match";
}

/**
 * Verify one execution-provenance arm for a pinned artifact digest against an
 * explicit store — the seam every conjunct is witnessed through.
 */
export async function verifyExecutionProvenanceWith(
  store: ExecutionProvenanceStoreV1, root: string, req: ExecutionProvenanceReq, slug: string, pinnedDigest: string,
): Promise<ExecutionProvenanceVerdictV1> {
  let inventory: Awaited<ReturnType<ExecutionProvenanceStoreV1["scanInventory"]>>;
  try {
    inventory = await store.scanInventory(root);
  } catch (error) {
    return { verdict: "park", detail: `the preparation store could not be scanned: ${(error as Error).message}` };
  }
  // FAIL CLOSED on a degraded scan: a truncated or problem-bearing inventory may
  // have DROPPED the vouching run, so "not found" would be could-not-see.
  if (inventory.problems.length > 0) {
    return { verdict: "park", detail: `the preparation inventory reported ${inventory.problems.length} problem(s); provenance cannot be verified` };
  }
  let unreadable = 0;
  for (const manifest of inventory.manifests) {
    if (manifest.plan.actionAuthority.actionId !== req.actionId) continue;
    const outcome = await candidateOutcome(store, root, manifest, req, slug, pinnedDigest);
    if (outcome === "vouches") {
      return { verdict: "pass", detail: `run ${manifest.runId} admitted the pinned bytes under output '${req.resultOutputId}'` };
    }
    if (outcome === "unreadable") unreadable += 1;
  }
  // A candidate that could not be READ may be the vouching one: park, not deny.
  if (unreadable > 0) {
    return { verdict: "park", detail: `${unreadable} candidate run(s) could not be read; provenance cannot be verified` };
  }
  return {
    verdict: "deny",
    detail: `no succeeded '${req.actionId}' run with ${req.slugInputField}=${JSON.stringify(slug)} admitted the pinned bytes under output '${req.resultOutputId}'`,
  };
}

/**
 * Verify one execution-provenance arm for a pinned artifact digest.
 *
 * @param root - Absolute project root (the caller already holds its lock; every
 *   read here is lock-free).
 * @param req - The declared arm: action id, slug input field, result output id.
 * @param slug - The transitioning entity's slug.
 * @param pinnedDigest - The pinned artifact's `sha256:<hex>` digest.
 * @returns pass when a succeeded matching run admitted exactly these bytes under
 *   the declared output; park when the store could not be verified; deny otherwise.
 */
export function verifyExecutionProvenance(
  root: string, req: ExecutionProvenanceReq, slug: string, pinnedDigest: string,
): Promise<ExecutionProvenanceVerdictV1> {
  return verifyExecutionProvenanceWith(PREPARATION_STORE, root, req, slug, pinnedDigest);
}

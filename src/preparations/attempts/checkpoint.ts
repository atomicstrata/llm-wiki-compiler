/**
 * @file src/preparations/attempts/checkpoint.ts
 * @description Opaque provider-checkpoint lineage binding and resume eligibility
 * (design section 16.3). A checkpoint reference is untrusted, immutable provider
 * bytes retained by digest; the host never trusts them but binds the EXACT
 * lineage under which they were produced — provider pin, capability contract,
 * invocation schema, input exposure, authority snapshot, prior checkpoint, and
 * a monotonic index. Resume is authorized ONLY when Provider V2 would accept the
 * exact lineage AND every recorded digest still equals the value recomputed from
 * the current sealed attempt: any single mismatched dimension fails closed and
 * refuses resume (allowlist over denylist). The lineage is recomputed from the
 * SEALED attempt (never a caller-supplied constant), so a forged ref cannot make
 * a stale checkpoint appear resumable.
 */

import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import { parseSha256Digest } from "../../capability-providers/ids.js";
import type { EvidenceRefV1, Sha256Digest } from "../types.js";
import type { SealedAttemptContextV1 } from "./types.js";

const CHECKPOINT_LINEAGE_DOMAIN = "llmwiki-preparation-checkpoint-lineage-v1";

/**
 * One immutable checkpoint reference (design section 16.3). Every digest is
 * recomputable, so a loader or resume check can reject a forged value; the
 * opaque bytes themselves live out of line as `checkpoint`-retention evidence.
 */
export interface PreparationCheckpointRefV1 {
  readonly evidenceRef: EvidenceRefV1;
  readonly providerPinDigest: Sha256Digest;
  readonly capabilityContractDigest: Sha256Digest;
  readonly invocationSchemaDigest: Sha256Digest;
  readonly inputExposureSetDigest: Sha256Digest;
  readonly authoritySnapshotDigest: Sha256Digest;
  readonly priorCheckpointDigest?: Sha256Digest;
  readonly checkpointIndex: number;
}

/** The closed resume decision: an exact-lineage resume or a fail-closed refusal. */
export type CheckpointResumeDecision =
  | { readonly kind: "resume" }
  | { readonly kind: "incompatible"; readonly reason: string };

/** The exact lineage digests one checkpoint binds, minus its opaque evidence. */
interface CheckpointLineage {
  readonly providerPinDigest: Sha256Digest;
  readonly capabilityContractDigest: Sha256Digest;
  readonly invocationSchemaDigest: Sha256Digest;
  readonly inputExposureSetDigest: Sha256Digest;
  readonly authoritySnapshotDigest: Sha256Digest;
}

/**
 * Recompute the exact lineage a checkpoint must bind from the SEALED attempt.
 * Fails closed when the sealed executor is not a pinned provider capability or
 * the sealed authority omits a provider pin: a non-provider or pin-less phase
 * has no resumable provider lineage.
 */
function lineageFromSealed(sealed: SealedAttemptContextV1): CheckpointLineage {
  const executor = sealed.executor;
  if (executor.kind !== "provider-capability") throw new Error("checkpoint lineage requires a provider-capability executor");
  const pin = sealed.authority.providerPinDigest;
  if (pin === undefined) throw new Error("checkpoint lineage requires a sealed provider pin");
  return {
    providerPinDigest: pin,
    capabilityContractDigest: executor.capabilityContractDigest,
    invocationSchemaDigest: sealed.authority.executorDigest,
    inputExposureSetDigest: sealed.authority.inputExposureSetDigest,
    authoritySnapshotDigest: sealed.authoritySnapshotDigest,
  };
}

/**
 * Build the checkpoint reference for the opaque bytes a provider produced under
 * the sealed attempt. The lineage is taken from the sealed attempt, never a
 * caller value; the evidence ref must carry `checkpoint` retention and remain
 * untrusted. `checkpointIndex` is monotonic and `priorCheckpointDigest` chains a
 * successor to its predecessor: index 0 has no prior, index > 0 requires one.
 */
export function buildCheckpointRef(input: {
  sealed: SealedAttemptContextV1;
  evidenceRef: EvidenceRefV1;
  checkpointIndex: number;
  priorCheckpointDigest?: Sha256Digest;
}): PreparationCheckpointRefV1 {
  if (!Number.isSafeInteger(input.checkpointIndex) || input.checkpointIndex < 0) throw new Error("checkpoint index must be a nonnegative integer");
  if (input.evidenceRef.retention !== "checkpoint" || input.evidenceRef.untrusted !== true) throw new Error("checkpoint evidence must be untrusted checkpoint-retention bytes");
  if ((input.checkpointIndex === 0) !== (input.priorCheckpointDigest === undefined)) throw new Error("checkpoint index and prior-checkpoint chaining disagree");
  const lineage = lineageFromSealed(input.sealed);
  return Object.freeze({
    evidenceRef: input.evidenceRef, ...lineage, checkpointIndex: input.checkpointIndex,
    ...(input.priorCheckpointDigest === undefined ? {} : { priorCheckpointDigest: input.priorCheckpointDigest }),
  });
}

/** Bind one checkpoint reference into a recomputable digest for chaining/summary. */
export function checkpointDigest(ref: PreparationCheckpointRefV1): Sha256Digest {
  return parseSha256Digest(canonicalDigest({ domain: CHECKPOINT_LINEAGE_DOMAIN, ref }));
}

/** The single lineage dimension whose recorded digest disagrees with the seal. */
function lineageMismatch(sealed: CheckpointLineage, ref: PreparationCheckpointRefV1): string | null {
  if (ref.providerPinDigest !== sealed.providerPinDigest) return "provider-pin";
  if (ref.capabilityContractDigest !== sealed.capabilityContractDigest) return "capability-contract";
  if (ref.invocationSchemaDigest !== sealed.invocationSchemaDigest) return "invocation-schema";
  if (ref.inputExposureSetDigest !== sealed.inputExposureSetDigest) return "input-exposure";
  if (ref.authoritySnapshotDigest !== sealed.authoritySnapshotDigest) return "authority-snapshot";
  return null;
}

/**
 * Decide whether a checkpoint may resume under the CURRENT sealed attempt. Every
 * recorded lineage digest is recomputed from the seal and compared; any single
 * mismatch, a bad index, or a broken prior chain refuses resume. Only an exact
 * lineage match on every dimension authorizes resume (design section 16.3).
 */
export function classifyCheckpointResume(sealed: SealedAttemptContextV1, ref: PreparationCheckpointRefV1): CheckpointResumeDecision {
  let expected: CheckpointLineage;
  try {
    expected = lineageFromSealed(sealed);
  } catch {
    return { kind: "incompatible", reason: "no-resumable-provider-lineage" };
  }
  if (!Number.isSafeInteger(ref.checkpointIndex) || ref.checkpointIndex < 0) return { kind: "incompatible", reason: "checkpoint-index-invalid" };
  if ((ref.checkpointIndex === 0) !== (ref.priorCheckpointDigest === undefined)) return { kind: "incompatible", reason: "checkpoint-chain-broken" };
  if (ref.evidenceRef.retention !== "checkpoint" || ref.evidenceRef.untrusted !== true) return { kind: "incompatible", reason: "checkpoint-evidence-invalid" };
  const mismatch = lineageMismatch(expected, ref);
  return mismatch === null ? { kind: "resume" } : { kind: "incompatible", reason: `checkpoint-${mismatch}-drift` };
}

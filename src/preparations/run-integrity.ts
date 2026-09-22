/**
 * @file src/preparations/run-integrity.ts
 * @description Canonical transition hashing, domain-separated preparation-key
 * epoch identity, whole-record HMAC-SHA256, constant-time comparison, and pure
 * constructors for the version-one preparation-run chain (design sections 12.1
 * through 12.3). Nothing here touches the filesystem: these are the cryptographic
 * and pure-projection primitives the run store composes with confined durable I/O.
 */

import { createHash, createHmac } from "node:crypto";
import { hmacHexEqual as preparationRunIntegrityMatches } from "../utils/hmac-equal.js";
import { appendRunAnnotations, successorEnvelope } from "../utils/run-history-projection.js";
import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import { parseSha256Digest } from "../capability-providers/ids.js";
import type { Sha256Digest } from "./types.js";
import type {
  AppendPreparationTransitionInput, InitialPreparationRunInput,
  PreparationRunBinding, PreparationRunContentV1, PreparationRunPredecessor,
  PreparationRunTransitionV1, PreparationRunV1,
} from "./run-types.js";

const PREPARATION_KEY_BYTES = 32;
const KEY_EPOCH_DOMAIN = Buffer.from("llmwiki.preparation-run-key-epoch.v1\0", "utf8");

/** Require exactly the V2 preparation-key entropy before cryptographic use. */
function assertPreparationKey(key: Buffer): void {
  if (key.length !== PREPARATION_KEY_BYTES) throw new Error("preparation key must contain 32 bytes");
}

/** Derive the public key-epoch identifier from a domain and raw key bytes. */
export function preparationKeyEpochId(key: Buffer): Sha256Digest {
  assertPreparationKey(key);
  const digest = createHash("sha256").update(KEY_EPOCH_DOMAIN).update(key).digest("hex");
  return parseSha256Digest(`sha256:${digest}`);
}

/** Hash canonical transition bytes after omitting the transition's own hash. */
export function preparationTransitionHash(
  transition: PreparationRunTransitionV1 | Omit<PreparationRunTransitionV1, "contentHash">,
): Sha256Digest {
  const { contentHash: _contentHash, ...content } = transition as PreparationRunTransitionV1;
  const digest = createHash("sha256").update(canonicalBytes(content)).digest("hex");
  return parseSha256Digest(`sha256:${digest}`);
}

/** Compute whole-record HMAC over canonical bytes with integrity omitted. */
function preparationRunIntegrity(key: Buffer, run: PreparationRunContentV1 | PreparationRunV1): string {
  assertPreparationKey(key);
  const { integrity: _integrity, ...content } = run as PreparationRunV1;
  return createHmac("sha256", key).update(canonicalBytes(content)).digest("hex");
}

/** Return the exact binding projected from a parsed run. */
export function preparationRunBinding(run: PreparationRunContentV1): PreparationRunBinding {
  return {
    runId: run.runId, preparationId: run.preparationId, manifestDigest: run.manifestDigest,
    workspaceId: run.workspaceId, keyEpochId: run.keyEpochId,
  };
}

/** True only when every supplied external identity names this run. */
export function preparationRunBindingMatches(run: PreparationRunContentV1, binding: PreparationRunBinding): boolean {
  const actual = preparationRunBinding(run);
  return actual.runId === binding.runId && actual.preparationId === binding.preparationId
    && actual.manifestDigest === binding.manifestDigest
    && actual.workspaceId === binding.workspaceId && actual.keyEpochId === binding.keyEpochId;
}

/** Cryptographic primitive for validated storage candidates and tamper tests. */
export function signPreparationRun(key: Buffer, run: PreparationRunContentV1 | PreparationRunV1): PreparationRunV1 {
  const { integrity: _integrity, ...content } = run as PreparationRunV1;
  return { ...content, integrity: preparationRunIntegrity(key, content) };
}

/** Verify HMAC, external binding, and the domain-derived current key epoch. */
export function verifyPreparationRunIntegrity(
  run: PreparationRunV1, key: Buffer, binding: PreparationRunBinding,
): boolean {
  if (preparationKeyEpochId(key) !== run.keyEpochId) return false;
  if (!preparationRunBindingMatches(run, binding)) return false;
  return preparationRunIntegrityMatches(run.integrity, preparationRunIntegrity(key, run));
}

/** Clone one principal so caller-owned objects cannot alias durable state. */
function cloneActor(actor: InitialPreparationRunInput["actor"]): InitialPreparationRunInput["actor"] {
  return { id: actor.id, surface: actor.surface };
}

/** Require positive control-transition headroom before genesis construction. */
function assertControlAllowance(allowance: number): number {
  if (!Number.isSafeInteger(allowance) || allowance <= 0) {
    throw new Error("preparation run requires positive control transition headroom");
  }
  return allowance;
}

/** Construct the sole valid genesis transition and initial `planned` run record. */
export function createInitialPreparationRun(input: InitialPreparationRunInput): PreparationRunContentV1 {
  const controlTransitionAllowance = assertControlAllowance(input.controlTransitionAllowance);
  const transitionContent = {
    sequence: 0, previousHash: null, actor: cloneActor(input.actor),
    stateBefore: "planned" as const, stateAfter: "planned" as const,
    type: "run-planned" as const, at: input.at, payload: { kind: "none" as const },
  };
  const genesis = { ...transitionContent, contentHash: preparationTransitionHash(transitionContent) };
  return {
    schemaVersion: 1, runId: input.runId, preparationId: input.preparationId,
    manifestDigest: input.manifestDigest, workspaceId: input.workspaceId,
    keyEpochId: input.keyEpochId, state: "planned", stateVersion: 1,
    controlTransitionAllowance,
    phaseSummaries: [], gateProofs: [], brokerRequestSummaries: [], effectSummaries: [],
    evidenceRefs: [], completeness: { requiredDeficit: 0, optionalDeficit: 0 },
    completionWarnings: [], notices: [], residualFindings: [], transitions: [genesis],
    createdAt: input.at, updatedAt: input.at,
  };
}

/** Bind the verified handoff binding named by a `handoff` payload. */
function boundHandoff(
  transition: PreparationRunTransitionV1,
  supplied: AppendPreparationTransitionInput["handoff"],
) {
  if (transition.payload.kind !== "handoff") {
    if (supplied !== undefined) throw new Error("handoff binding is handoff-only");
    return undefined;
  }
  if (supplied === undefined || supplied.handoffId !== transition.payload.handoffId
    || supplied.bundleManifestDigest !== transition.payload.bundleManifestDigest) {
    throw new Error("handoff binding does not match its transition payload");
  }
  return { ...supplied };
}

/** Bind the verified residual findings named by an `abandonment` payload. */
function boundResiduals(
  transition: PreparationRunTransitionV1,
  supplied: AppendPreparationTransitionInput["residualFindings"],
) {
  if (transition.payload.kind !== "abandonment") {
    if (supplied !== undefined) throw new Error("residual findings are abandonment-only");
    return undefined;
  }
  if (supplied === undefined || supplied.length !== transition.payload.findingCount) {
    throw new Error("abandonment residual binding count mismatch");
  }
  return supplied.map((finding) => ({
    ...finding, ...(finding.evidence === undefined ? {} : { evidence: { ...finding.evidence } }),
  }));
}

/** Project bounded warning, notice, supersession, handoff, and residual facts. */
function appendProjection(
  run: PreparationRunContentV1,
  transition: PreparationRunTransitionV1,
  input: AppendPreparationTransitionInput,
) {
  const payload = transition.payload;
  const { completionWarnings, notices } = appendRunAnnotations(run,
    payload.kind === "warning" ? payload : undefined, payload.kind === "notice" ? payload : undefined);
  const supersededByPreparationId = payload.kind === "supersede"
    ? payload.supersededByPreparationId : run.supersededByPreparationId;
  const handoff = boundHandoff(transition, input.handoff) ?? run.handoff;
  const residualFindings = boundResiduals(transition, input.residualFindings) ?? [...run.residualFindings];
  return {
    completionWarnings, notices, residualFindings,
    ...(supersededByPreparationId === undefined ? {} : { supersededByPreparationId }),
    ...(handoff === undefined ? {} : { handoff }),
  };
}

/** Purely append one hash-chained transition and its projected facts. */
export function appendPreparationTransition(
  run: PreparationRunContentV1 | PreparationRunV1,
  input: AppendPreparationTransitionInput,
): PreparationRunContentV1 {
  const { integrity: _integrity, ...content } = run as PreparationRunV1;
  const prior = content.transitions.at(-1);
  if (prior === undefined) throw new Error("preparation run has no genesis transition");
  const transitionContent = successorEnvelope(content, prior.contentHash, {
    actor: cloneActor(input.actor), stateAfter: input.stateAfter, type: input.type, at: input.at, payload: input.payload,
  });
  const transition = { ...transitionContent, contentHash: preparationTransitionHash(transitionContent) };
  const { supersededByPreparationId: _prior, handoff: _priorHandoff, ...base } = content;
  const projection = appendProjection(content, transition, input);
  return {
    ...base, state: input.stateAfter, stateVersion: content.stateVersion + 1,
    ...projection, transitions: [...content.transitions, transition], updatedAt: input.at,
  };
}

/** Capture the exact authenticated prefix expected by a later locked append. */
export function preparationRunPredecessor(run: PreparationRunContentV1): PreparationRunPredecessor {
  const chainTip = run.transitions.at(-1)?.contentHash;
  if (chainTip === undefined) throw new Error("preparation run has no genesis transition");
  return { stateVersion: run.stateVersion, chainTip };
}

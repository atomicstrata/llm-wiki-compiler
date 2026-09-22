/**
 * @file src/operation-bundles/run-integrity.ts
 * @description Canonical transition hashing, domain-separated operation-key
 * epoch identity, whole-record HMAC-SHA256, constant-time comparison, and pure
 * constructors for the version-one operation-run chain.
 */

import { createHash, createHmac } from "node:crypto";
import { hmacHexEqual } from "../utils/hmac-equal.js";
import { appendRunAnnotations, successorEnvelope } from "../utils/run-history-projection.js";
import { canonicalBytes, canonicalDigest } from "../profile/templates/signing/canonical.js";
import { compensationId, mutationId } from "./ids.js";
import type { MutationId } from "./ids.js";
import { residualFindingsDigest } from "./run-residuals.js";
import type { OperationDigest } from "./types.js";
import type {
  AppendOperationTransitionInput, CompensationOutcome, InitialOperationRunInput,
  MutationOutcome, OperationRun, OperationRunBinding, OperationRunContent,
  OperationRunCounters, OperationRunObligations, OperationRunPredecessor,
  OperationRunTransition, ProjectionOutcome,
} from "./run-types.js";

const OPERATION_KEY_BYTES = 32;
const KEY_EPOCH_DOMAIN = Buffer.from("llmwiki.operation-run-key-epoch.v1\0", "utf8");

/** Require exactly the V2 operation-key entropy before cryptographic use. */
function assertOperationKey(key: Buffer): void {
  if (key.length !== OPERATION_KEY_BYTES) throw new Error("operation key must contain 32 bytes");
}

/** Derive the public key-epoch identifier from a domain and raw key bytes. */
export function operationKeyEpochId(key: Buffer): OperationDigest {
  assertOperationKey(key);
  const digest = createHash("sha256").update(KEY_EPOCH_DOMAIN).update(key).digest("hex");
  return `sha256:${digest}`;
}

/** Hash canonical transition bytes after omitting the transition's own hash. */
export function operationTransitionHash(transition: OperationRunTransition | Omit<OperationRunTransition, "contentHash">): OperationDigest {
  const { contentHash: _contentHash, ...content } = transition as OperationRunTransition;
  const digest = createHash("sha256").update(canonicalBytes(content)).digest("hex");
  return `sha256:${digest}`;
}

/** Compute whole-record HMAC over canonical bytes with integrity omitted. */
function operationRunIntegrity(key: Buffer, run: OperationRunContent | OperationRun): string {
  assertOperationKey(key);
  const { integrity: _integrity, ...content } = run as OperationRun;
  return createHmac("sha256", key).update(canonicalBytes(content)).digest("hex");
}

/** Compare two canonical lowercase HMAC values in constant time. */
export function operationRunIntegrityMatches(stored: string, expected: string): boolean {
  return hmacHexEqual(stored, expected);
}

/** Return the exact binding projected from a parsed run. */
export function operationRunBinding(run: OperationRunContent): OperationRunBinding {
  return {
    runId: run.runId, bundleId: run.bundleId, manifestDigest: run.manifestDigest,
    workspaceId: run.workspaceId, keyEpochId: run.keyEpochId,
  };
}

/** True only when every supplied external identity names this run. */
export function operationRunBindingMatches(run: OperationRunContent, binding: OperationRunBinding): boolean {
  const actual = operationRunBinding(run);
  return actual.runId === binding.runId && actual.bundleId === binding.bundleId
    && actual.manifestDigest === binding.manifestDigest
    && actual.workspaceId === binding.workspaceId
    && actual.keyEpochId === binding.keyEpochId;
}

/** Cryptographic primitive for validated storage candidates and tamper tests; it performs no persistence. */
export function signOperationRun(key: Buffer, run: OperationRunContent | OperationRun): OperationRun {
  const { integrity: _integrity, ...content } = run as OperationRun;
  return { ...content, integrity: operationRunIntegrity(key, content) };
}

/** Verify HMAC, external binding, and the domain-derived current key epoch. */
export function verifyOperationRunIntegrity(run: OperationRun, key: Buffer, binding: OperationRunBinding): boolean {
  if (operationKeyEpochId(key) !== run.keyEpochId) return false;
  if (!operationRunBindingMatches(run, binding)) return false;
  return operationRunIntegrityMatches(run.integrity, operationRunIntegrity(key, run));
}

/** Clone a principal so caller-owned grant arrays cannot alias durable state. */
function cloneActor(actor: InitialOperationRunInput["actor"]): InitialOperationRunInput["actor"] {
  return { id: actor.id, surface: actor.surface, grants: [...actor.grants] };
}

/** Build the empty counters carried by every newly staged run. */
function emptyCounters(): OperationRunCounters {
  return {
    mutations: { attempted: 0, applied: 0, skipped: 0, failed: 0 },
    compensations: { attempted: 0, completed: 0, failed: 0 },
    projections: { attempted: 0, applied: 0, skipped: 0, failed: 0 },
  };
}

/** Derive exact authoritative, projection, and compensation identities. */
function deriveObligations(input: InitialOperationRunInput): OperationRunObligations {
  const { manifest } = input;
  if (canonicalDigest(manifest) !== input.manifestDigest) throw new Error("operation manifest digest mismatch");
  const authoritativeMutationIds: MutationId[] = [];
  const projections: OperationRunObligations["projections"][number][] = [];
  manifest.mutations.forEach((item, index) => {
    const expected = mutationId(manifest.bundleId, index);
    if (item.index !== index || item.mutationId !== expected) throw new Error("operation manifest mutation identity mismatch");
    if (item.kind === "projection") projections.push({ mutationId: expected, criticality: item.target.criticality });
    else authoritativeMutationIds.push(expected);
  });
  const declared = [...input.declaredCompensatorMutationIds];
  if (new Set(declared).size !== declared.length || declared.some((id) => !authoritativeMutationIds.includes(id))) {
    throw new Error("declared compensator does not name an authoritative manifest mutation");
  }
  const compensations = declared.map((id) => ({ mutationId: id, compensationId: compensationId(id) }));
  return { authoritativeMutationIds, compensations, projections };
}

/** Validate manifest/run binding before constructing the sole genesis record. */
function genesisBinding(input: InitialOperationRunInput): OperationRunBinding {
  const { manifest } = input;
  if (manifest.createdAt !== input.at) throw new Error("operation run creation time must match manifest creation time");
  if (!Number.isSafeInteger(input.controlTransitionAllowance) || input.controlTransitionAllowance <= 0) {
    throw new Error("operation run requires positive control transition headroom");
  }
  return {
    runId: manifest.runId, bundleId: manifest.bundleId, workspaceId: manifest.workspaceId,
    manifestDigest: input.manifestDigest, keyEpochId: input.keyEpochId,
  };
}

/** Construct the sole valid genesis transition and initial run record. */
export function createInitialOperationRun(input: InitialOperationRunInput): OperationRunContent {
  const binding = genesisBinding(input);
  const obligations = deriveObligations(input);
  const transitionContent = {
    sequence: 0, previousHash: null, actor: cloneActor(input.actor),
    stateBefore: "awaiting-approval" as const, stateAfter: "awaiting-approval" as const,
    type: "run-staged" as const, at: input.at, payload: { kind: "none" as const },
  };
  const genesis = { ...transitionContent, contentHash: operationTransitionHash(transitionContent) };
  return {
    schemaVersion: 1, ...binding, state: "awaiting-approval", stateVersion: 1,
    controlTransitionAllowance: input.controlTransitionAllowance,
    authoritySnapshotDigest: null, obligations, mutationOutcomes: [],
    compensationOutcomes: [], projectionOutcomes: [], counters: emptyCounters(),
    completionWarnings: [], notices: [], residualFindings: [], transitions: [genesis],
    createdAt: input.at, updatedAt: input.at,
  };
}

/** Replace one current outcome while preserving first-seen array order. */
function upsert<T>(items: readonly T[], key: (item: T) => string, next: T): T[] {
  const target = key(next);
  const index = items.findIndex((item) => key(item) === target);
  if (index < 0) return [...items, next];
  return items.map((item, position) => position === index ? next : item);
}

/** Project mutation outcome state from a mutation transition type. */
function mutationStatus(type: string): MutationOutcome["status"] | null {
  if (type === "mutation-started") return "started";
  if (type === "mutation-applied") return "applied";
  if (type === "mutation-skipped-idempotent") return "skipped-idempotent";
  return type === "mutation-failed" ? "failed" : null;
}

/** Project compensation outcome state from a compensation transition type. */
function compensationStatus(type: string): CompensationOutcome["status"] | null {
  if (type === "compensation-started") return "started";
  if (type === "compensation-completed") return "completed";
  return type === "compensation-failed" ? "failed" : null;
}

/** Project one current outcome array from the newly appended transition. */
function appendOutcomes(run: OperationRunContent, transition: OperationRunTransition) {
  let mutationOutcomes = [...run.mutationOutcomes];
  let compensationOutcomes = [...run.compensationOutcomes];
  let projectionOutcomes = [...run.projectionOutcomes];
  const payload = transition.payload;
  const mutation = mutationStatus(transition.type);
  if (payload.kind === "mutation" && mutation !== null) {
    mutationOutcomes = upsert(mutationOutcomes, (item) => item.mutationId, { mutationId: payload.mutationId, status: mutation, transitionSequence: transition.sequence, ...(payload.detail === undefined ? {} : { detail: payload.detail }) });
  }
  const projection = mutationStatus(transition.type.replace("projection-", "mutation-"));
  if (payload.kind === "projection" && projection !== null) {
    projectionOutcomes = upsert(projectionOutcomes, (item) => item.mutationId, { mutationId: payload.mutationId, criticality: payload.criticality, status: projection, transitionSequence: transition.sequence });
  }
  const compensation = compensationStatus(transition.type);
  if (payload.kind === "compensation" && compensation !== null) {
    compensationOutcomes = upsert(compensationOutcomes, (item) => item.compensationId, { compensationId: payload.compensationId, mutationId: payload.mutationId, status: compensation, transitionSequence: transition.sequence });
  }
  return { mutationOutcomes, compensationOutcomes, projectionOutcomes };
}

/** Project authority and owner fields from one metadata-bearing transition. */
function appendAuthority(run: OperationRunContent, transition: OperationRunTransition) {
  const payload = transition.payload;
  let authoritySnapshotDigest = run.authoritySnapshotDigest;
  if (payload.kind === "authority") {
    authoritySnapshotDigest = payload.authoritySnapshotDigest;
  }
  const clearsAuthority = ["approval-invalidated", "rejected", "superseded", "cancelled", "failed"]
    .includes(transition.type);
  if (clearsAuthority) authoritySnapshotDigest = null;
  const active = transition.stateAfter === "applying" || transition.stateAfter === "compensating";
  const applyOwner = payload.kind === "execution" ? { ...payload.applyOwner } : run.applyOwner;
  return { authoritySnapshotDigest, ...(active && applyOwner !== undefined ? { applyOwner } : {}) };
}

/** Clone and bind detailed abandonment observations outside the transition. */
function boundResidualFindings(
  transition: OperationRunTransition,
  supplied: AppendOperationTransitionInput["residualFindings"],
) {
  if (transition.payload.kind !== "abandonment") {
    if (supplied !== undefined) throw new Error("residual findings are abandonment-only");
    return undefined;
  }
  if (supplied === undefined || transition.payload.findingCount !== supplied.length
    || transition.payload.findingsDigest !== residualFindingsDigest(supplied)) {
    throw new Error("abandonment residual binding mismatch");
  }
  return supplied.map((finding) => ({
    ...finding,
    ...(finding.evidence === undefined ? {} : { evidence: { ...finding.evidence } }),
  }));
}

/** Project bounded warning, notice, and out-of-envelope residual arrays. */
function appendAnnotations(
  run: OperationRunContent,
  transition: OperationRunTransition,
  supplied: AppendOperationTransitionInput["residualFindings"],
) {
  const payload = transition.payload;
  const { completionWarnings, notices } = appendRunAnnotations(run,
    payload.kind === "warning" ? payload : undefined, payload.kind === "notice" ? payload : undefined);
  const bound = boundResidualFindings(transition, supplied);
  const residualFindings = bound ?? [...run.residualFindings];
  return { completionWarnings, notices, residualFindings };
}

/** Recompute checked status counters from current outcome arrays. */
export function operationRunCounters(outcomes: Pick<OperationRunContent, "mutationOutcomes" | "compensationOutcomes" | "projectionOutcomes">): OperationRunCounters {
  const mutations = outcomes.mutationOutcomes;
  const compensations = outcomes.compensationOutcomes;
  const projections = outcomes.projectionOutcomes;
  return {
    mutations: { attempted: mutations.length, applied: mutations.filter((item) => item.status === "applied").length, skipped: mutations.filter((item) => item.status === "skipped-idempotent").length, failed: mutations.filter((item) => item.status === "failed").length },
    compensations: { attempted: compensations.length, completed: compensations.filter((item) => item.status === "completed").length, failed: compensations.filter((item) => item.status === "failed").length },
    projections: { attempted: projections.length, applied: projections.filter((item) => item.status === "applied").length, skipped: projections.filter((item) => item.status === "skipped-idempotent").length, failed: projections.filter((item) => item.status === "failed").length },
  };
}

/** Purely append one hash-chained transition and current outcome projection. */
export function appendOperationTransition(run: OperationRunContent | OperationRun, input: AppendOperationTransitionInput): OperationRunContent {
  const { integrity: _integrity, ...content } = run as OperationRun;
  const { applyOwner: _priorOwner, ...contentWithoutOwner } = content;
  const prior = content.transitions.at(-1);
  if (prior === undefined) throw new Error("operation run has no genesis transition");
  const transitionContent = successorEnvelope(content, prior.contentHash, {
    actor: cloneActor(input.actor), stateAfter: input.stateAfter, type: input.type, at: input.at, payload: input.payload,
  });
  const transition = { ...transitionContent, contentHash: operationTransitionHash(transitionContent) };
  const outcomes = appendOutcomes(content, transition);
  const authority = appendAuthority(content, transition);
  const annotations = appendAnnotations(content, transition, input.residualFindings);
  return {
    ...contentWithoutOwner, state: input.stateAfter, stateVersion: content.stateVersion + 1,
    ...authority, ...annotations, ...outcomes, counters: operationRunCounters(outcomes),
    transitions: [...content.transitions, transition], updatedAt: input.at,
  };
}

/** Capture the exact authenticated prefix expected by a later locked append. */
export function operationRunPredecessor(run: OperationRunContent): OperationRunPredecessor {
  const chainTip = run.transitions.at(-1)?.contentHash;
  if (chainTip === undefined) throw new Error("operation run has no genesis transition");
  return { stateVersion: run.stateVersion, chainTip };
}

/**
 * @file src/preparations/ids.ts
 * @description Typed Orchestration V2 identifiers (design section 9.1).
 * Preparation and run identifiers are host-minted lowercase random identities;
 * phase-instance, attempt, broker-request, gate-proof, and handoff identifiers
 * are stable SHA-256 derivations over the exact domain-separated byte strings.
 * Every derivation is recomputable so a loader can reject a mismatched id.
 */

import { createHash, randomBytes } from "node:crypto";
import { isSafeFilenameComponent } from "../profile/identity.js";
import { MAX_SAFE_COMPONENT_BYTES } from "./constants.js";
import {
  exactPreparationIdentity,
  PreparationIdentityError,
  type PreparationIdentityKind,
} from "./problems.js";

export type PreparationId = `prp_${string}`;
export type PreparationRunId = `prr_${string}`;
export type PhaseInstanceId = `phi_${string}`;
export type AttemptId = `pat_${string}`;
export type BrokerRequestId = `brq_${string}`;
export type GateProofId = `gpf_${string}`;
export type HandoffId = `hof_${string}`;

const RANDOM_IDENTITY_BYTES = 16;
const RANDOM_PATTERN = /^[0-9a-f]{32}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const PREFIXED_RANDOM_CODE_UNITS = 36;
const PREFIXED_DIGEST_CODE_UNITS = 68;

const PHASE_DOMAIN = "llmwiki-preparation-phase-v1";
const ATTEMPT_DOMAIN = "llmwiki-preparation-attempt-v1";
const BROKER_DOMAIN = "llmwiki-preparation-broker-v1";
const GATE_DOMAIN = "llmwiki-preparation-gate-v1";
const HANDOFF_DOMAIN = "llmwiki-preparation-handoff-v1";

/** Upper bound applied to each index before it seeds a derived identity. */
const MAX_DERIVATION_INDEX = 4_096;

/** Hash one NUL-separated domain-separated identity input as lowercase SHA-256. */
function sha256(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0"), "utf8").digest("hex");
}

/** Validate that a hash input string is a bounded, non-empty NUL-free value. */
function safeInput(value: string, kind: PreparationIdentityKind): string {
  if (value.length === 0 || value.includes("\0")) throw new PreparationIdentityError(kind);
  return value;
}

/** Require a nonnegative bounded index before it seeds a derived identity. */
function safeIndex(value: number, kind: PreparationIdentityKind): string {
  if (!Number.isSafeInteger(value) || value < 0 || value >= MAX_DERIVATION_INDEX) {
    throw new PreparationIdentityError(kind);
  }
  return String(value);
}

/** Validate a prefixed host-minted lowercase random identity. */
function assertRandomId(value: unknown, prefix: string, kind: PreparationIdentityKind): void {
  const identity = exactPreparationIdentity(value, kind, PREFIXED_RANDOM_CODE_UNITS);
  if (!identity.startsWith(prefix) || !RANDOM_PATTERN.test(identity.slice(prefix.length))) {
    throw new PreparationIdentityError(kind);
  }
}

/** Validate a prefixed deterministic SHA-256 identity. */
function assertDigestId(value: unknown, prefix: string, kind: PreparationIdentityKind): void {
  const identity = exactPreparationIdentity(value, kind, PREFIXED_DIGEST_CODE_UNITS);
  if (!identity.startsWith(prefix) || !DIGEST_PATTERN.test(identity.slice(prefix.length))) {
    throw new PreparationIdentityError(kind);
  }
}

/**
 * Validate one interpolated safe path/identity component (design section 9.1):
 * the shared safe-filename grammar plus the shared length cap. Every workspace,
 * phase, capability, handler, and completeness-class component funnels here.
 */
export function isSafeComponent(value: unknown): value is string {
  try {
    assertSafeComponent(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Require a bounded, filename-safe path component.
 *
 * {@link isSafeComponent} is the predicate form, and it ROUTES THROUGH THIS
 * function rather than restating the grammar: a surface that must answer
 * "is this admissible?" as a typed refusal, and a writer that enforces it,
 * reading two copies of one rule is the drift this program keeps paying for.
 */
export function assertSafeComponent(value: unknown): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_SAFE_COMPONENT_BYTES ||
    !isSafeFilenameComponent(value)
  ) {
    throw new PreparationIdentityError("safe-component");
  }
  return value;
}

/** Mint a new preparation id in the reserved lowercase random namespace. */
export function mintPreparationId(): PreparationId {
  return `prp_${randomBytes(RANDOM_IDENTITY_BYTES).toString("hex")}`;
}

/** Mint a new preparation-run id in the reserved lowercase random namespace. */
export function mintPreparationRunId(): PreparationRunId {
  return `prr_${randomBytes(RANDOM_IDENTITY_BYTES).toString("hex")}`;
}

/** Assert and brand one preparation id. */
export function assertPreparationId(value: unknown): PreparationId {
  assertRandomId(value, "prp_", "preparation-id");
  return value as PreparationId;
}

/** Assert and brand one preparation-run id. */
export function assertPreparationRunId(value: unknown): PreparationRunId {
  assertRandomId(value, "prr_", "preparation-run-id");
  return value as PreparationRunId;
}

/** Assert and brand one phase-instance id. */
export function assertPhaseInstanceId(value: unknown): PhaseInstanceId {
  assertDigestId(value, "phi_", "phase-instance-id");
  return value as PhaseInstanceId;
}

/** Assert and brand one attempt id. */
export function assertAttemptId(value: unknown): AttemptId {
  assertDigestId(value, "pat_", "attempt-id");
  return value as AttemptId;
}

/** Assert and brand one broker-request id. */
export function assertBrokerRequestId(value: unknown): BrokerRequestId {
  assertDigestId(value, "brq_", "broker-request-id");
  return value as BrokerRequestId;
}

/** Assert and brand one gate-proof id. */
export function assertGateProofId(value: unknown): GateProofId {
  assertDigestId(value, "gpf_", "gate-proof-id");
  return value as GateProofId;
}

/** Assert and brand one handoff id. */
export function assertHandoffId(value: unknown): HandoffId {
  assertDigestId(value, "hof_", "handoff-id");
  return value as HandoffId;
}

/** Derive the stable phase-instance identity for one expansion of a phase. */
export function derivePhaseInstanceId(input: {
  manifestDigest: string;
  logicalPhaseId: string;
  expansionIdentity: string;
}): PhaseInstanceId {
  return assertPhaseInstanceId(`phi_${sha256([
    PHASE_DOMAIN,
    safeInput(input.manifestDigest, "phase-instance-id"),
    assertSafeComponent(input.logicalPhaseId),
    safeInput(input.expansionIdentity, "expansion-identity"),
  ])}`);
}

/** Derive the stable attempt identity for one zero-based attempt index. */
export function deriveAttemptId(phaseInstanceId: PhaseInstanceId, attemptIndex: number): AttemptId {
  assertPhaseInstanceId(phaseInstanceId);
  return assertAttemptId(`pat_${sha256([ATTEMPT_DOMAIN, phaseInstanceId, safeIndex(attemptIndex, "attempt-index")])}`);
}

/** Derive the stable broker-request identity for one zero-based request index. */
export function deriveBrokerRequestId(attemptId: AttemptId, requestIndex: number): BrokerRequestId {
  assertAttemptId(attemptId);
  return assertBrokerRequestId(`brq_${sha256([BROKER_DOMAIN, attemptId, safeIndex(requestIndex, "request-index")])}`);
}

/** Derive the stable gate-proof identity for one decision over a plan digest. */
export function deriveGateProofId(input: {
  runId: PreparationRunId;
  gateId: string;
  planDigest: string;
  decisionIndex: number;
}): GateProofId {
  assertPreparationRunId(input.runId);
  return assertGateProofId(`gpf_${sha256([
    GATE_DOMAIN,
    input.runId,
    assertSafeComponent(input.gateId),
    safeInput(input.planDigest, "gate-proof-id"),
    safeIndex(input.decisionIndex, "decision-index"),
  ])}`);
}

/** Derive the stable handoff identity for one final transition hash. */
export function deriveHandoffId(runId: PreparationRunId, finalTransitionHash: string): HandoffId {
  assertPreparationRunId(runId);
  return assertHandoffId(`hof_${sha256([HANDOFF_DOMAIN, runId, safeInput(finalTransitionHash, "handoff-id")])}`);
}

/** Canonical expansion identity for a non-expanding single phase. */
export function singleExpansionIdentity(): string {
  return "single";
}

/** Canonical expansion identity for one bounded-repeat iteration index. */
export function repeatExpansionIdentity(iterationIndex: number): string {
  return `repeat-${safeIndex(iterationIndex, "expansion-identity")}`;
}

/** Canonical expansion identity for one map item's stable host identity. */
export function mapExpansionIdentity(itemIdentity: string): string {
  return `map-${safeInput(itemIdentity, "expansion-identity")}`;
}

/** Brand tripwires — see `src/types/brand-assertions.ts`. */
import type { BrandAssertFalse, BrandAssignable, BrandProbe } from "../types/brand-assertions.js";

type _PreparationIdIsBranded = BrandAssertFalse<BrandAssignable<BrandProbe, PreparationId>>;
type _PreparationRunIdIsBranded = BrandAssertFalse<BrandAssignable<BrandProbe, PreparationRunId>>;
type _PhaseInstanceIdIsBranded = BrandAssertFalse<BrandAssignable<BrandProbe, PhaseInstanceId>>;
type _AttemptIdIsBranded = BrandAssertFalse<BrandAssignable<BrandProbe, AttemptId>>;
type _BrokerRequestIdIsBranded = BrandAssertFalse<BrandAssignable<BrandProbe, BrokerRequestId>>;
type _GateProofIdIsBranded = BrandAssertFalse<BrandAssignable<BrandProbe, GateProofId>>;
type _HandoffIdIsBranded = BrandAssertFalse<BrandAssignable<BrandProbe, HandoffId>>;

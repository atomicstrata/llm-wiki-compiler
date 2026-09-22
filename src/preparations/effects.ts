/**
 * @file src/preparations/effects.ts
 * @description Governed mutating external effects and honest non-atomicity
 * (design section 18). A mutating external effect records a DURABLE START in the
 * authenticated run under the project lock BEFORE the Provider V2 broker call,
 * then — after the broker runs outside the lock — commits ONLY a host-minted
 * receipt: provider output never proves an effect and absence of a receipt never
 * proves it did not happen. An `outcome-unknown` receipt parks the run and, by
 * the run loader's terminal rules, blocks retry, terminal success, cancellation
 * settlement, supersession, and handoff. There is no ad hoc rollback: a
 * follow-up or reversal is a separately declared, separately granted, separately
 * receipted effect. Atomicity-class consistency is enforced at plan load AND at
 * runtime, and a `non-atomic-external-before-local` plan is labelled non-atomic
 * forever — the label derives from the immutable plan class and is never
 * silently reconciled to an atomic claim by any later success.
 */

import { canonicalDigest } from "../profile/templates/signing/canonical.js";
import { parseBrokerId, parseInvocationId, parseSemanticVersion, parseSha256Digest } from "../capability-providers/ids.js";
import { captureExternalEffectReceipt, deriveExternalEffectId, externalEffectReceiptDigest, type ExternalEffectReceiptV1 } from "../capability-providers/brokers/receipts.js";
import type { HostEffectClaimFactsV1 } from "../capability-providers/brokers/effect-state.js";
import type { EffectIdV1 } from "../capability-providers/types.js";
import type { ProviderRollbackSemanticsV1 } from "../capability-providers/authority/types.js";
import { captureOwnDataRecord } from "../utils/runtime-capture.js";
import { ownerFencesAttempt } from "./attempts/lease.js";
import { deriveBrokerRequestId, type AttemptId, type BrokerRequestId, type PhaseInstanceId, type PreparationRunId } from "./ids.js";
import { findApprovedGateProof, phaseBindingDigest, planAuthorityDigest, revalidateApprovedGateProof } from "./gates.js";
import { preparationManifestDigest } from "./manifest-parse.js";
import { readPreparationManifest } from "./manifest-store.js";
import { capturePreparationPrincipal, preparationRunActor, requirePreparationGrant, type PreparationPrincipal } from "./principals.js";
import type { NormalizedPhaseV1, NormalizedPreparationPlanV1, PhaseGateKind, PreparationAtomicityClass } from "./plan-types.js";
import { preparationRunPredecessor } from "./run-integrity.js";
import { appendProjectedTransitionLocked, readPreparationRun, type PreparationRunContentProjector } from "./run-store.js";
import type {
  AppendPreparationTransitionInput, BrokerRequestSummaryV1, EffectSummaryV1,
  GateProofSummaryV1, PreparationRunBinding, PreparationRunV1,
} from "./run-types.js";
import type { Sha256Digest } from "./types.js";

/** Closed reason an external effect authority check failed closed. */
export type EffectAuthorityCode =
  | "effect-forbidden-by-class" | "atomicity-inconsistent" | "missing-effect-gate"
  | "wrong-gate-kind" | "missing-residual-risk-gate" | "effect-plan-unbound"
  | "invalid-effect-plan" | "receipt-mismatch" | "effect-not-started"
  | "effect-not-fenced" | "manifest-unavailable"
  | "follow-up-not-distinct" | "follow-up-not-declared" | "follow-up-not-granted";

/** Typed refusal raised for every external-effect authority failure. */
export class EffectAuthorityError extends Error {
  readonly code: EffectAuthorityCode;
  constructor(code: EffectAuthorityCode) {
    super(`preparation external-effect authority: ${code}`);
    this.name = "EffectAuthorityError";
    this.code = code;
  }
}
/**
 * The immutable declaration of one mutating external effect (design section
 * 18.2). Its canonical digest is the `effectPlanEntryDigest` bound by the
 * authenticated normalized plan's phase; the plan carries no raw credential.
 */
export interface PreparationEffectPlanV1 {
  readonly schemaVersion: 1;
  readonly effectClass: string;
  readonly targetIdentity: string;
  readonly providerPinDigest: Sha256Digest;
  readonly grantSnapshotDigest: Sha256Digest;
  readonly brokerId: string;
  readonly brokerContractVersion: string;
  readonly invocationId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: Sha256Digest;
  readonly rollbackSemantics: ProviderRollbackSemanticsV1;
  readonly followUpEffectPlanDigest?: Sha256Digest;
}

const EFFECT_PLAN_KEYS = Object.freeze([
  "schemaVersion", "effectClass", "targetIdentity", "providerPinDigest",
  "grantSnapshotDigest", "brokerId", "brokerContractVersion", "invocationId",
  "idempotencyKey", "requestDigest", "rollbackSemantics",
] as const);
const OPTIONAL_EFFECT_PLAN_KEYS = Object.freeze(["followUpEffectPlanDigest"] as const);

const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ROLLBACK_VALUES = Object.freeze(["none", "broker-reversible", "follow-up-effect-only"] as const);

/** Require a bounded token; reject anything outside the closed token grammar. */
function token(value: unknown): string {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) throw new EffectAuthorityError("invalid-effect-plan");
  return value;
}
/** Recompute the canonical effect-plan-entry digest from a captured plan. */
export function effectPlanEntryDigest(plan: PreparationEffectPlanV1): Sha256Digest {
  return parseSha256Digest(canonicalDigest(captureEffectPlan(plan)));
}
/** Deep-capture and closed-validate one untrusted effect-plan record. */
function captureEffectPlan(value: unknown): PreparationEffectPlanV1 {
  let record: Readonly<Record<string, unknown>>;
  try { record = captureOwnDataRecord(value); }
  catch { throw new EffectAuthorityError("invalid-effect-plan"); }
  const keys = Object.keys(record);
  const allowed = new Set<string>([...EFFECT_PLAN_KEYS, ...OPTIONAL_EFFECT_PLAN_KEYS]);
  if (EFFECT_PLAN_KEYS.some((key) => !keys.includes(key)) || keys.some((key) => !allowed.has(key))) {
    throw new EffectAuthorityError("invalid-effect-plan");
  }
  if (record.schemaVersion !== 1 || !ROLLBACK_VALUES.includes(record.rollbackSemantics as ProviderRollbackSemanticsV1)) {
    throw new EffectAuthorityError("invalid-effect-plan");
  }
  return Object.freeze({
    schemaVersion: 1, effectClass: token(record.effectClass), targetIdentity: token(record.targetIdentity),
    providerPinDigest: parseSha256Digest(record.providerPinDigest), grantSnapshotDigest: parseSha256Digest(record.grantSnapshotDigest),
    brokerId: token(record.brokerId), brokerContractVersion: token(record.brokerContractVersion),
    invocationId: token(record.invocationId), idempotencyKey: token(record.idempotencyKey),
    requestDigest: parseSha256Digest(record.requestDigest),
    rollbackSemantics: record.rollbackSemantics as ProviderRollbackSemanticsV1,
    ...(record.followUpEffectPlanDigest === undefined
      ? {} : { followUpEffectPlanDigest: parseSha256Digest(record.followUpEffectPlanDigest) }),
  });
}
/** True when any phase of the plan declares a mutating external effect. */
function declaresMutatingEffect(plan: NormalizedPreparationPlanV1): boolean {
  return plan.phases.some((phase) => phase.effectPlanDigest !== undefined);
}
/**
 * Re-enforce, at runtime, the exact atomicity-class rules the plan loader checks
 * (design section 10.4): a `local-bundle-only` plan carries no mutating effect,
 * an `external-effect-only` plan carries an effect and no local bundle, and a
 * `non-atomic-external-before-local` plan carries an effect, a local bundle, and
 * a residual-risk gate. A durable plan that drifts from its class fails closed.
 */
export function assertAtomicityClassConsistency(plan: NormalizedPreparationPlanV1): void {
  if (plan.executionMode !== "durable-preparation") return;
  const effect = declaresMutatingEffect(plan);
  const bundle = plan.outputContract.handoffCapacity !== undefined;
  const residualGate = gateIdOfKind(plan, "confirm-residual-risk") !== undefined;
  const ok: Record<PreparationAtomicityClass, boolean> = {
    "local-bundle-only": !effect && bundle,
    "external-effect-only": effect && !bundle,
    "non-atomic-external-before-local": effect && bundle && residualGate,
  };
  if (!ok[plan.atomicityClass]) throw new EffectAuthorityError("atomicity-inconsistent");
}
/** The permanent external-before-local honesty label (design section 18.4). */
export type ExternalLocalAtomicityLabel = "non-atomic" | "single-authority";

/**
 * Derive the external-local atomicity label purely from the immutable plan class.
 * A `non-atomic-external-before-local` plan is `non-atomic` forever; because the
 * label is plan-derived and not run-state-derived, no later success, handoff, or
 * reconciliation can ever turn it into an atomic claim.
 */
export function externalLocalAtomicityLabel(plan: NormalizedPreparationPlanV1): ExternalLocalAtomicityLabel {
  return plan.atomicityClass === "non-atomic-external-before-local" ? "non-atomic" : "single-authority";
}
/** Find the plan gate id for the single gate of one kind, if present. */
function gateIdOfKind(plan: NormalizedPreparationPlanV1, kind: PhaseGateKind): string | undefined {
  return plan.phases.find((phase) => phase.gate?.gateKind === kind)?.gate?.gateId;
}

/** Require the named gate to exist in the plan with the exact expected kind. */
function requireGateKindInPlan(plan: NormalizedPreparationPlanV1, gateId: string, kind: PhaseGateKind): void {
  const present = plan.phases.some((phase) => phase.gate?.gateId === gateId && phase.gate?.gateKind === kind);
  if (!present) throw new EffectAuthorityError("wrong-gate-kind");
}

/**
 * Fail closed unless a mutating external effect is permitted right now: the plan
 * class must allow effects, an approved `confirm-external-effect` proof bound to
 * the CURRENT plan digest must exist, and a `non-atomic-external-before-local`
 * run must additionally carry an approved, current `confirm-residual-risk` proof.
 * A stale proof (its recorded plan digest differs after revision) never counts.
 */
export function assertRuntimeEffectPermitted(input: {
  plan: NormalizedPreparationPlanV1;
  gateProofs: readonly GateProofSummaryV1[];
  externalEffectGateId: string;
  currentPlanDigest: Sha256Digest;
}): void {
  assertAtomicityClassConsistency(input.plan);
  if (input.plan.atomicityClass === "local-bundle-only") throw new EffectAuthorityError("effect-forbidden-by-class");
  requireGateKindInPlan(input.plan, input.externalEffectGateId, "confirm-external-effect");
  if (findApprovedGateProof(input.gateProofs, input.externalEffectGateId, input.currentPlanDigest) === undefined) {
    throw new EffectAuthorityError("missing-effect-gate");
  }
  if (input.plan.atomicityClass === "non-atomic-external-before-local") {
    const residualGateId = gateIdOfKind(input.plan, "confirm-residual-risk");
    if (residualGateId === undefined
      || findApprovedGateProof(input.gateProofs, residualGateId, input.currentPlanDigest) === undefined) {
      throw new EffectAuthorityError("missing-residual-risk-gate");
    }
  }
}

/**
 * EVERY authority-, identity-, and timing-bearing dimension of one mutating
 * effect's provider request — the COMPLETE pre-hoc claim (design section 18.2).
 * A single source of truth: {@link completeEffectAuthorityClaim} binds exactly
 * these keys, the durable start persists that digest, and the commit recomputes
 * it from the host receipt. A future receipt field must be classified here or in
 * {@link EFFECT_CLAIM_EXCLUSIONS}; the completeness invariant test enforces that,
 * so no dimension can silently escape the binding.
 */
export const EFFECT_CLAIM_DIMENSIONS = Object.freeze([
  "invocationId", "providerPinDigest", "grantSnapshotDigest", "effectPlanEntryDigest",
  "brokerId", "brokerContractVersion", "effectClass", "targetIdentity",
  "requestDigest", "idempotencyKey", "startedAt", "rollbackSemantics",
] as const);

/**
 * Receipt fields DELIBERATELY excluded from the pre-hoc claim: constants, the
 * effect identity (verified separately), and outcome/observation fields that are
 * only known AFTER the broker call and so cannot be part of what was authorized.
 */
export const EFFECT_CLAIM_EXCLUSIONS = Object.freeze([
  "schemaVersion", "sensitiveFieldsOmitted", "effectId",
  "outcome", "completedAt", "observedExternalIdentity", "responseDigest",
] as const);

/**
 * Bind the COMPLETE authority claim of one effect into a single canonical digest,
 * driven by {@link EFFECT_CLAIM_DIMENSIONS}. Both the durable start (from the host
 * claim facts) and the commit (from the host receipt) call this exact function, so
 * a receipt that differs on ANY bound dimension yields a different digest and is
 * refused — there is no per-field subset left to drift.
 */
function completeEffectAuthorityClaim(source: Readonly<Record<string, unknown>>): Sha256Digest {
  const claim: Record<string, unknown> = { domain: "llmwiki-preparation-effect-claim-v1" };
  for (const key of EFFECT_CLAIM_DIMENSIONS) claim[key] = source[key];
  return parseSha256Digest(canonicalDigest(claim));
}

/** The host-authored durable-start facts and derived identities for one effect. */
export interface EffectStartContext {
  readonly effectId: EffectIdV1;
  readonly brokerRequestId: BrokerRequestId;
  readonly brokerRequestIndex: number;
  readonly claimDigest: Sha256Digest;
  readonly claimFacts: HostEffectClaimFactsV1;
}

/**
 * Build the host-authored claim facts and identities for one mutating effect,
 * binding the effect plan to the authenticated normalized plan: the recomputed
 * `effectPlanEntryDigest` must equal the plan-declared `boundEffectPlanDigest`,
 * so a caller cannot start an effect the plan never declared. No broker call
 * happens here; these facts are the durable pre-hoc truth recorded before it.
 */
export function buildEffectStartContext(input: {
  preparationRunId: PreparationRunId;
  attemptId: AttemptId;
  brokerRequestIndex: number;
  startedAt: string;
  effectPlan: PreparationEffectPlanV1;
  boundEffectPlanDigest: Sha256Digest;
}): EffectStartContext {
  const plan = captureEffectPlan(input.effectPlan);
  const entryDigest = effectPlanEntryDigest(plan);
  if (entryDigest !== parseSha256Digest(input.boundEffectPlanDigest)) throw new EffectAuthorityError("effect-plan-unbound");
  const effectId = deriveExternalEffectId(input.preparationRunId, plan.invocationId, input.brokerRequestIndex);
  const claimFacts: HostEffectClaimFactsV1 = {
    schemaVersion: 1, invocationId: parseInvocationId(plan.invocationId),
    providerPinDigest: plan.providerPinDigest, grantSnapshotDigest: plan.grantSnapshotDigest,
    effectPlanEntryDigest: entryDigest, brokerId: parseBrokerId(plan.brokerId),
    brokerContractVersion: parseSemanticVersion(plan.brokerContractVersion), effectClass: plan.effectClass,
    targetIdentity: plan.targetIdentity, requestDigest: plan.requestDigest, idempotencyKey: plan.idempotencyKey,
    startedAt: input.startedAt, rollbackSemantics: plan.rollbackSemantics,
  };
  return {
    effectId, brokerRequestId: deriveBrokerRequestId(input.attemptId, input.brokerRequestIndex),
    brokerRequestIndex: input.brokerRequestIndex,
    claimDigest: completeEffectAuthorityClaim(claimFacts as unknown as Record<string, unknown>), claimFacts,
  };
}

/** Replace or append one effect summary keyed by attempt id and effect index. */
function upsertEffectSummary(existing: readonly EffectSummaryV1[], next: EffectSummaryV1): readonly EffectSummaryV1[] {
  const filtered = existing.filter((item) => !(item.attemptId === next.attemptId && item.effectIndex === next.effectIndex));
  return [...filtered, next];
}

/** Replace or append one broker-request summary keyed by its request id. */
function upsertBrokerSummary(existing: readonly BrokerRequestSummaryV1[], next: BrokerRequestSummaryV1): readonly BrokerRequestSummaryV1[] {
  const filtered = existing.filter((item) => item.brokerRequestId !== next.brokerRequestId);
  return [...filtered, next];
}

/** Project a durable effect START: broker-request `started` plus effect `started`. */
function startProjector(attemptId: AttemptId, effectIndex: number, context: EffectStartContext): PreparationRunContentProjector {
  return (next) => ({
    ...next,
    brokerRequestSummaries: upsertBrokerSummary(next.brokerRequestSummaries, {
      brokerRequestId: context.brokerRequestId, attemptId, requestIndex: context.brokerRequestIndex, state: "started",
    }),
    effectSummaries: upsertEffectSummary(next.effectSummaries, {
      attemptId, effectIndex, outcome: "started", effectId: context.effectId,
      claimDigest: context.claimDigest, brokerRequestId: context.brokerRequestId,
    }),
  });
}

/** Read the authenticated run or throw; the gate proofs it carries are trusted. */
async function requireAuthenticatedRun(root: string, binding: PreparationRunBinding): Promise<PreparationRunV1> {
  const read = await readPreparationRun(root, binding);
  if (read.status !== "ok") throw new EffectAuthorityError("atomicity-inconsistent");
  return read.run;
}

/** The authenticated plan, phase, and authority an effect start is bound to. */
interface AuthenticatedEffectContext {
  readonly plan: NormalizedPreparationPlanV1;
  readonly planDigest: Sha256Digest;
  readonly phase: NormalizedPhaseV1;
  readonly effectPlanDigest: Sha256Digest;
  readonly authorityDigest: Sha256Digest;
}

/**
 * Resolve the effect's authority from the AUTHENTICATED manifest — never the
 * caller. The run's phase summary maps the phase instance to a logical phase; the
 * manifest (whose digest must match the run binding) supplies that phase's exact
 * declared `effectPlanDigest`, the plan digest, and the authority digest.
 */
async function resolveAuthenticatedEffectContext(
  root: string, binding: PreparationRunBinding, run: PreparationRunV1, phaseInstanceId: PhaseInstanceId,
): Promise<AuthenticatedEffectContext> {
  const summary = run.phaseSummaries.find((phase) => phase.phaseInstanceId === phaseInstanceId);
  if (summary === undefined) throw new EffectAuthorityError("effect-not-started");
  const read = await readPreparationManifest(root, binding.workspaceId, binding.preparationId);
  if (read.status !== "ok" || preparationManifestDigest(read.manifest) !== binding.manifestDigest) {
    throw new EffectAuthorityError("manifest-unavailable");
  }
  const plan = read.manifest.plan;
  const phase = plan.phases.find((candidate) => candidate.logicalPhaseId === summary.logicalPhaseId);
  if (phase?.effectPlanDigest === undefined) throw new EffectAuthorityError("effect-plan-unbound");
  return {
    plan, planDigest: parseSha256Digest(canonicalDigest(plan)), phase,
    effectPlanDigest: parseSha256Digest(phase.effectPlanDigest), authorityDigest: planAuthorityDigest(plan),
  };
}

/**
 * Authorize a mutating effect against the authenticated run and plan: the class
 * must permit it, an approved `confirm-external-effect` proof must exist, and that
 * proof must still match the CURRENT plan/input/effect/authority binding on every
 * dimension (design section 17.4) — a proof that drifted on any dimension, not
 * just the plan digest, is rejected here before the effect starts.
 */
function authorizeEffectGates(
  run: PreparationRunV1, context: AuthenticatedEffectContext, phaseInstanceId: PhaseInstanceId,
  externalEffectGateId: string, currentInputDigest: Sha256Digest,
): void {
  assertRuntimeEffectPermitted({
    plan: context.plan, gateProofs: run.gateProofs, externalEffectGateId, currentPlanDigest: context.planDigest,
  });
  const proof = findApprovedGateProof(run.gateProofs, externalEffectGateId, context.planDigest);
  if (proof === undefined) throw new EffectAuthorityError("missing-effect-gate");
  revalidateApprovedGateProof(proof, {
    planDigest: context.planDigest, phaseDigest: phaseBindingDigest(phaseInstanceId), inputDigest: currentInputDigest,
    effectDigest: context.effectPlanDigest, authorityDigest: context.authorityDigest,
  });
}

/**
 * Record the durable START of one mutating external effect UNDER the project
 * lock, before any broker call. Everything the start binds is derived from
 * AUTHENTICATED state, never the caller: the plan, phase, effect-plan digest, and
 * authority come from the manifest (matched to the run binding); the gate proof
 * comes from the signed run and is revalidated on every bound dimension; and the
 * run's execution owner must FENCE the active attempt/lease, so a start can only
 * be recorded for the run's own live attempt. The returned context carries the
 * claim facts the caller passes to the broker OUTSIDE the lock.
 */
export async function recordEffectStartLocked(input: {
  root: string;
  binding: PreparationRunBinding;
  principal: PreparationPrincipal;
  at: string;
  phaseInstanceId: PhaseInstanceId;
  attemptId: AttemptId;
  leaseNonce: string;
  effectIndex: number;
  brokerRequestIndex: number;
  externalEffectGateId: string;
  effectPlan: PreparationEffectPlanV1;
  currentInputDigest: Sha256Digest;
}): Promise<{ run: PreparationRunV1; context: EffectStartContext }> {
  const principal = capturePreparationPrincipal(input.principal);
  requirePreparationGrant(principal, "preparation.effect.approve");
  const priorRun = await requireAuthenticatedRun(input.root, input.binding);
  if (!ownerFencesAttempt(priorRun.executionOwner, input.attemptId, input.leaseNonce)) {
    throw new EffectAuthorityError("effect-not-fenced");
  }
  const authority = await resolveAuthenticatedEffectContext(input.root, input.binding, priorRun, input.phaseInstanceId);
  authorizeEffectGates(priorRun, authority, input.phaseInstanceId, input.externalEffectGateId, input.currentInputDigest);
  const context = buildEffectStartContext({
    preparationRunId: input.binding.runId, attemptId: input.attemptId, brokerRequestIndex: input.brokerRequestIndex,
    startedAt: input.at, effectPlan: input.effectPlan, boundEffectPlanDigest: authority.effectPlanDigest,
  });
  const transition: AppendPreparationTransitionInput = {
    type: "phase-progressed", stateAfter: "running", actor: preparationRunActor(principal), at: input.at,
    payload: { kind: "phase", phaseInstanceId: input.phaseInstanceId, phaseState: "running" },
  };
  const run = await appendProjectedTransitionLocked(
    input.root, input.binding, preparationRunPredecessor(priorRun), transition, startProjector(input.attemptId, input.effectIndex, context),
  );
  return { run, context };
}

/** The honest classification of one host effect receipt. */
export type EffectReceiptClassification =
  | { readonly kind: "settled"; readonly outcome: Exclude<EffectSummaryV1["outcome"], "planned" | "started" | "outcome-unknown"> }
  | { readonly kind: "park" };

/**
 * Classify a host receipt outcome. `outcome-unknown` parks; every other outcome
 * settles honestly. Provider output never enters this decision — only the
 * host-minted receipt's own outcome.
 */
export function classifyReceiptOutcome(receipt: ExternalEffectReceiptV1): EffectReceiptClassification {
  if (receipt.outcome === "outcome-unknown") return { kind: "park" };
  return { kind: "settled", outcome: receipt.outcome };
}

/** The authenticated durable-start facts a commit binds its receipt against. */
interface AuthenticatedStart {
  readonly effectId: string;
  readonly claimDigest: Sha256Digest;
  readonly brokerRequestId: BrokerRequestId;
  readonly brokerRequestIndex: number;
}

/**
 * Fail closed unless the authenticated run holds the durable START for this exact
 * effect AND the receipt is bound to it on EVERY authority dimension: a `started`
 * effect summary at (attemptId, effectIndex) carrying a persisted effect IDENTITY,
 * claim digest, and BROKER-REQUEST ASSOCIATION; a matching `started` broker request
 * for that persisted association; and — decisively — a receipt whose effect id equals
 * the PERSISTED (authenticated) identity and whose recomputed complete claim equals
 * the persisted claim. Both the effect identity AND the bound broker request are
 * authenticated from durable state, never the caller-supplied context, so neither a
 * substituted `context.effectId` nor a cross-wired `context.brokerRequestId` (naming
 * a different effect's request) can commit: a context that disagrees with the persisted
 * association fails closed here, and the settle uses only the persisted request. A
 * receipt that differs on any dimension fails closed. This is the symmetric guard for
 * the backstop.
 */
function bindReceiptToDurableStart(
  run: PreparationRunV1, context: EffectStartContext, receipt: ExternalEffectReceiptV1,
  attemptId: AttemptId, effectIndex: number,
): AuthenticatedStart {
  const started = run.effectSummaries.find(
    (effect) => effect.attemptId === attemptId && effect.effectIndex === effectIndex && effect.outcome === "started",
  );
  if (started?.claimDigest === undefined || started.effectId === undefined || started.brokerRequestId === undefined) {
    throw new EffectAuthorityError("effect-not-started");
  }
  const startedRequest = run.brokerRequestSummaries.find(
    (request) => request.brokerRequestId === started.brokerRequestId && request.state === "started",
  );
  if (startedRequest === undefined) throw new EffectAuthorityError("effect-not-started");
  if (context.brokerRequestId !== started.brokerRequestId
    || receipt.effectId !== started.effectId
    || completeEffectAuthorityClaim(receipt as unknown as Record<string, unknown>) !== started.claimDigest) {
    throw new EffectAuthorityError("receipt-mismatch");
  }
  return {
    effectId: started.effectId, claimDigest: started.claimDigest,
    brokerRequestId: started.brokerRequestId, brokerRequestIndex: startedRequest.requestIndex,
  };
}

/** Project the settled receipt outcome onto the run's broker and effect summaries. */
function commitProjector(
  attemptId: AttemptId, effectIndex: number,
  outcome: EffectSummaryV1["outcome"], start: AuthenticatedStart, receiptDigest: Sha256Digest,
): PreparationRunContentProjector {
  return (next) => ({
    ...next,
    brokerRequestSummaries: upsertBrokerSummary(next.brokerRequestSummaries, {
      brokerRequestId: start.brokerRequestId, attemptId, requestIndex: start.brokerRequestIndex, state: "settled",
    }),
    effectSummaries: upsertEffectSummary(next.effectSummaries, {
      attemptId, effectIndex, outcome, effectId: start.effectId,
      claimDigest: start.claimDigest, brokerRequestId: start.brokerRequestId, receiptDigest,
    }),
  });
}

/**
 * Commit ONLY the host receipt for one started effect UNDER the project lock,
 * after the broker call. The commit reuses the SAME stale-result fence the attempt
 * commit uses ({@link ownerFencesAttempt}): the freshly-read run owner must still
 * name this attempt and lease nonce, so a receipt arriving after cancellation,
 * supersession, or recovery rotated the nonce fails closed. The receipt must match
 * the started effect on every bound dimension. An `outcome-unknown` receipt parks
 * the run at `recovery-required`, which the loader's terminal rules use to forbid
 * success, cancellation settlement, supersession, and handoff.
 */
export async function commitEffectReceiptLocked(input: {
  root: string;
  binding: PreparationRunBinding;
  principal: PreparationPrincipal;
  at: string;
  phaseInstanceId: PhaseInstanceId;
  attemptId: AttemptId;
  leaseNonce: string;
  effectIndex: number;
  context: EffectStartContext;
  receipt: ExternalEffectReceiptV1;
}): Promise<PreparationRunV1> {
  const principal = capturePreparationPrincipal(input.principal);
  requirePreparationGrant(principal, "preparation.effect.approve");
  // Capture the untrusted receipt ONCE into a frozen validated record so the
  // match decision, classification, and digest all read the same bytes (R2).
  const receipt = captureExternalEffectReceipt(input.receipt);
  const priorRun = await requireAuthenticatedRun(input.root, input.binding);
  if (!ownerFencesAttempt(priorRun.executionOwner, input.attemptId, input.leaseNonce)) {
    throw new EffectAuthorityError("effect-not-fenced");
  }
  const start = bindReceiptToDurableStart(priorRun, input.context, receipt, input.attemptId, input.effectIndex);
  const receiptDigest = externalEffectReceiptDigest(receipt);
  const classification = classifyReceiptOutcome(receipt);
  const outcome: EffectSummaryV1["outcome"] = classification.kind === "park" ? "outcome-unknown" : classification.outcome;
  const settledProjector = commitProjector(input.attemptId, input.effectIndex, outcome, start, receiptDigest);
  // A park settles the effect AND clears the execution owner: the run leaves the
  // running state for recovery-required, where an owner is no longer valid.
  const projector: PreparationRunContentProjector = classification.kind === "park"
    ? (next) => { const { executionOwner: _cleared, ...rest } = settledProjector(next); return rest; }
    : settledProjector;
  const transition: AppendPreparationTransitionInput = classification.kind === "park"
    ? {
        type: "recovery-required", stateAfter: "recovery-required", actor: preparationRunActor(principal), at: input.at,
        payload: { kind: "problem", code: "preparation-effect-outcome-unknown" },
      }
    : {
        type: "phase-progressed", stateAfter: "running", actor: preparationRunActor(principal), at: input.at,
        payload: { kind: "phase", phaseInstanceId: input.phaseInstanceId, phaseState: "running" },
      };
  return appendProjectedTransitionLocked(input.root, input.binding, preparationRunPredecessor(priorRun), transition, projector);
}

/**
 * Fail closed unless a follow-up or reversal is a SEPARATELY governed effect: it
 * must be the follow-up the plan declared, it must be a distinct effect plan from
 * the original, and it must carry its own approved, current `confirm-external-
 * effect` proof. There is no ad hoc rollback (design section 18.3).
 */
export function assertFollowUpEffectSeparatelyGoverned(input: {
  plan: NormalizedPreparationPlanV1;
  currentPlanDigest: Sha256Digest;
  gateProofs: readonly GateProofSummaryV1[];
  originalEffectPlanDigest: Sha256Digest;
  declaredFollowUpDigest: Sha256Digest | undefined;
  followUpEffectPlanDigest: Sha256Digest;
  followUpGateId: string;
}): void {
  if (input.followUpEffectPlanDigest === input.originalEffectPlanDigest) throw new EffectAuthorityError("follow-up-not-distinct");
  if (input.declaredFollowUpDigest === undefined || input.declaredFollowUpDigest !== input.followUpEffectPlanDigest) {
    throw new EffectAuthorityError("follow-up-not-declared");
  }
  requireGateKindInPlan(input.plan, input.followUpGateId, "confirm-external-effect");
  if (findApprovedGateProof(input.gateProofs, input.followUpGateId, input.currentPlanDigest) === undefined) {
    throw new EffectAuthorityError("follow-up-not-granted");
  }
}

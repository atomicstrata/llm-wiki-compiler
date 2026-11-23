/**
 * @file src/portable/project/propose.ts
 * @description `proposal.persist`: run the shared review-mode compile inside
 * the host and persist what it generated as one immutable record batch.
 *
 * A model run can be long, and the gate also serializes policy changes, so the
 * operation runs in three steps:
 *
 *  1. under the gate, briefly: consult the identity record and take a
 *     generation lease;
 *  2. outside the gate: run the compile through the recording access seam. It
 *     has staged no authoritative write, so it blocks nothing;
 *  3. under the gate again: require the lease epoch to be current AND the
 *     identity record to still be in progress, validate the dependencies, run
 *     the content floor, and persist the batch.
 *
 * At most one proposal is ever persisted per operation id. The model may run
 * more than once after a lease takeover; authoritative state cannot repeat.
 */

import { randomUUID } from "node:crypto";
import { runReviewProposal } from "../../compiler/compile-phases.js";
import { COMPILE_ORIGIN } from "../../trust/checks.js";
import { runContentFloor } from "../../trust/content-floor.js";
import { withQuiet } from "../../utils/output.js";
import { runWithProviderOverride } from "../../utils/provider.js";
import type { ReviewCandidate } from "../../utils/types.js";
import {
  begin, holdsAtEffect, intentDigestOf, PublishWithdrawn, refuse, submit, type OperationRequest, type FinalSyncGuard, type PublishGuard, type ResolvedPublication,
} from "../authority/authority.js";
import { isLeaseLive, recoverLocked, type Authority } from "../authority/status.js";
import { validateDependencies } from "../authority/validate.js";
import { RecordingCompileAccess } from "../compile/recording-access.js";
import type {
  ApplyDependenciesV1, ObjectImage, OperationIdentityRecordV1, ProposalOutcome, RefusalCode, SkippedItem,
} from "../contracts.js";
import { recordDigest } from "../digest.js";
import { PortableDenied, PortableRefusal } from "../errors.js";
import { isOperationIdValid } from "../host/operation-ids.js";
import { authorize } from "../host/policy.js";
import { CONFIG_PATH, conceptPagePath } from "../logical-paths.js";
import type { ProposeRequest } from "./api.js";
import { buildProposalBatch } from "./proposal-records.js";
import { requireHostModel, type ProjectRuntime } from "./runtime.js";

/** What step 1 hands to step 3, carried inside the host only: the lease taken and the fence captured. */
type Begun =
  | { kind: "proceed"; epoch: number; owner: string; fence: PolicyFence }
  | { kind: "settled"; outcome: ProposalOutcome };

/** The lease a generation runs under, as step 1 took it. Passed to `generate`; it grants nothing by itself. */
export interface GenerationLease { operationId: string; epoch: number; owner: string; fence: PolicyFence }

/** The base-policy and ticket revisions generation STARTED under. */
export type PolicyFence = { policyRevision: number; ticketRevision: number };

/** A further admission check a proposal path adds; asked wherever the verbs are. `null` admits. */
export type ExtraEffectCheck = () => Promise<RefusalCode | null>;

/**
 * The two steps that differ between proposal paths. Everything else — the
 * identity record, the lease, the admission checks under the gate, the late
 * finisher's rejection and the commit — is the one protocol below.
 */
export interface GenerationSteps<A> {
  /** STEP 2, outside the gate: run the compile under `lease`. A refusal it throws is recorded. */
  generate(lease?: GenerationLease): Promise<A>;
  /** STEP 3 body, under the gate: turn what was generated into a resolved batch. */
  resolve(record: OperationIdentityRecordV1, generated: A, fence: PolicyFence): Promise<ResolvedPublication>;
  /** Checked at admission and again at the effect, beside the required verbs. */
  extraCheck?: ExtraEffectCheck;
  /** A lease shorter than the host's: always capped by `maxLeaseMs`, never longer. */
  leaseMs?: number;
  /**
   * Asked before persistence records a refusal or begins to submit; `false`
   * makes it a superseded late finisher that writes nothing. It guards
   * CUSTODY only, so a live, rightful holder can always settle a refusal.
   * Absent, persistence behaves exactly as before.
   */
  beforeEffect?: () => Promise<boolean>;
  /**
   * Passed to `submit` as the last await before the publish effect, after
   * submit's own fence check; `beforeEffect` then also guards every refusal
   * submit records. Absent, nothing changes.
   */
  beforePublish?: PublishGuard;
  /** Passed to `submit` as its synchronous last check before the publish call. Absent, nothing changes. */
  finalSync?: FinalSyncGuard;
}

/** True when a same-id retry may take over an expired, unstaged generation. */
async function canTakeOver(auth: Authority, existing: OperationIdentityRecordV1, request: OperationRequest): Promise<boolean> {
  if (existing.outcome !== "in-progress" || existing.kind !== request.kind) return false;
  if (existing.intentDigest !== request.intentDigest || isLeaseLive(existing)) return false;
  const staged = (await auth.store.unresolvedIntents()).includes(existing.operationId);
  return !staged && (await auth.store.getReceipt(existing.operationId)) === null;
}

/**
 * Why a proposal may not proceed right now, or `null`. Asked twice, under the
 * gate each time: before the model is allowed to run, and again before
 * anything is persisted; exported for a caller's own final guard. A verb or
 * clearance revoked in between is gone, and a parked intent blocks every
 * further write, a proposal included.
 */
async function effectRefusal(
  runtime: ProjectRuntime, request: OperationRequest, extraCheck?: ExtraEffectCheck,
): Promise<RefusalCode | null> {
  if (!(await holdsAtEffect(runtime, runtime.principal, request.requires))) return "permission_denied";
  const extra = extraCheck === undefined ? null : await extraCheck();
  if (extra !== null) return extra;
  return (await runtime.store.unresolvedIntents()).length > 0 ? "recovery_blocking" : null;
}

/** The lease length a generation asks for, capped by the host; a malformed request gets the host's own. */
function leaseLengthMs(runtime: ProjectRuntime, requested: number | undefined): number {
  const ceiling = runtime.control.limits.maxLeaseMs;
  const isUsable = requested !== undefined && Number.isFinite(requested) && requested > 0;
  return isUsable ? Math.min(requested, ceiling) : ceiling;
}

/** A step-1 outcome that ends the call without generating. */
type SettledBegin = Extract<Begun, { kind: "settled" }>;

/**
 * The identity record a generation runs under: the existing one when this
 * same-id call may take its expired lease over (asked only when one exists),
 * else the one `begin` records, or `begin`'s settled outcome.
 */
async function generationRecord(
  runtime: ProjectRuntime, request: OperationRequest, existing: OperationIdentityRecordV1 | null,
): Promise<{ kind: "record"; record: OperationIdentityRecordV1 } | SettledBegin> {
  if (existing !== null && (await canTakeOver(runtime, existing, request))) return { kind: "record", record: existing };
  const begun = await begin(runtime, runtime.principal, request);
  if (begun.kind === "settled") return { kind: "settled", outcome: begun.status as ProposalOutcome };
  return { kind: "record", record: begun.record };
}

/**
 * Admission under the gate, settled as this operation's recorded refusal, or
 * `null` to admit. Decided HERE, against current host state: the check made
 * before waiting for the gate is not enough, because a role revoked while this
 * call was queued must stop the model from running at all, and a lease
 * takeover skips `begin`, so a parked intent is also checked here. A host
 * configured with no model cannot generate; it is refused here too, before a
 * lease is taken or anything runs: never answered by a stand-in model, and
 * never by a provider read from the environment.
 */
async function admissionRefusal(
  runtime: ProjectRuntime, request: OperationRequest, record: OperationIdentityRecordV1, extraCheck: ExtraEffectCheck | undefined,
): Promise<SettledBegin | null> {
  const blocked = await effectRefusal(runtime, request, extraCheck);
  if (blocked !== null) return { kind: "settled", outcome: (await refuse(runtime, record, blocked)) as ProposalOutcome };
  if (runtime.model === null) return { kind: "settled", outcome: (await refuse(runtime, record, "capability_unsupported")) as ProposalOutcome };
  return null;
}

/**
 * The fence generation starts under, captured NOW, before the model runs.
 * Persisting later under a freshly read revision would launder a revocation
 * made during generation into the fence.
 */
async function captureFence(runtime: ProjectRuntime): Promise<PolicyFence> {
  const control = await runtime.control.loadProject(runtime.principal.project);
  if (control === null) throw new PortableDenied();
  return { policyRevision: control.policyRevision, ticketRevision: control.ticketRevision };
}

/** Take the generation lease on `record`: the next epoch after `existing`'s, a fresh owner, an expiry capped by the host. */
async function takeLease(
  runtime: ProjectRuntime, record: OperationIdentityRecordV1, existing: OperationIdentityRecordV1 | null, leaseMs: number | undefined, fence: PolicyFence,
): Promise<Extract<Begun, { kind: "proceed" }>> {
  const epoch = (existing?.generationLease?.epoch ?? 0) + 1;
  const owner = randomUUID();
  const expiresAt = new Date(Date.now() + leaseLengthMs(runtime, leaseMs)).toISOString();
  await runtime.store.putIdentity({ ...record, generationLease: { owner, epoch, expiresAt } });
  return { kind: "proceed", epoch, owner, fence };
}

/**
 * STEP 1, under the gate the caller holds: decide whether this submission
 * generates, and under which lease epoch and owner. In order: recovery, the
 * operation id, the identity record (take over or `begin`), admission, the
 * fence, the lease.
 */
async function beginGenerationLocked(
  runtime: ProjectRuntime, request: OperationRequest, options: Pick<GenerationSteps<unknown>, "extraCheck" | "leaseMs"> = {},
): Promise<Begun> {
  const auth: Authority = runtime;
  await recoverLocked(auth);
  if (!isOperationIdValid(runtime.control, runtime.principal, request.operationId)) {
    return { kind: "settled", outcome: { kind: "rejected", reason: "operation_id_not_valid" } };
  }
  const existing = await auth.store.getIdentity(request.operationId);
  const chosen = await generationRecord(runtime, request, existing);
  if (chosen.kind === "settled") return chosen;
  const refused = await admissionRefusal(runtime, request, chosen.record, options.extraCheck);
  if (refused !== null) return refused;
  const fence = await captureFence(runtime);
  return takeLease(runtime, chosen.record, existing, options.leaseMs, fence);
}

/**
 * The identity record when it is still in progress under EXACTLY this
 * lease's epoch and owner and the lease has not lapsed, else `null`.
 */
async function heldRecord(runtime: ProjectRuntime, request: OperationRequest, lease: GenerationLease): Promise<OperationIdentityRecordV1 | null> {
  const record = await runtime.store.getIdentity(request.operationId);
  const held = record?.generationLease;
  const isHeld = record !== null && record.outcome === "in-progress" && held?.epoch === lease.epoch && held.owner === lease.owner;
  return isHeld && isLeaseLive(record) ? record : null;
}

/** STEP 2: run the shared compile, under the host's model, reading only through the seam. */
async function generate(runtime: ProjectRuntime): Promise<RecordingCompileAccess> {
  // Pinned to one head where the adapter can pin; live (and validated later) where it cannot.
  const access = new RecordingCompileAccess(await runtime.store.generationView());
  await runWithProviderOverride(requireHostModel(runtime), () =>
    withQuiet(() => runReviewProposal(access, { review: true })));
  return access;
}

/** The pre-image generation observed for one candidate's target page. */
async function targetPreimage(
  runtime: ProjectRuntime, access: RecordingCompileAccess, candidate: ReviewCandidate, labels: readonly string[],
): Promise<ObjectImage> {
  const path = conceptPagePath(candidate.slug);
  const seen = access.observed(path) ?? { digest: (await runtime.store.observe(path))?.digest ?? "absent" };
  if (seen.digest === "absent") return { state: "absent" };
  const byteCount = (await runtime.store.observe(path))?.bytes.byteLength ?? 0;
  return { state: "present", digest: seen.digest, byteCount, labels };
}

/** Run the shared content floor over each candidate; a blocked page is skipped, never dropped silently. */
export async function partitionByFloor(
  candidates: readonly ReviewCandidate[], pathOf: (candidate: ReviewCandidate) => string = (candidate) => conceptPagePath(candidate.slug),
): Promise<{ allowed: ReviewCandidate[]; skipped: SkippedItem[] }> {
  const allowed: ReviewCandidate[] = [];
  const skipped: SkippedItem[] = [];
  for (const candidate of candidates) {
    const floor = await runContentFloor({
      directory: "concepts", slug: candidate.slug, body: candidate.body, origin: COMPILE_ORIGIN,
    });
    if (floor.allowed) allowed.push(candidate);
    else skipped.push({ path: pathOf(candidate), code: "floor_blocked" });
  }
  return { allowed, skipped };
}

/** The semantic inputs the compile recorded, as the proposal's dependencies. */
function dependenciesFrom(access: RecordingCompileAccess): Omit<ApplyDependenciesV1, "targets"> {
  const config = access.observed(CONFIG_PATH)?.digest ?? "absent";
  return {
    objects: access.recordedObjects(),
    listings: access.recordedListings(),
    reviewPolicyDigest: recordDigest({ config }),
    systemPolicyDigest: null,
    lineageScopedListings: [],
  };
}

/** STEP 3 body: turn what generation produced into a resolved proposal batch. */
async function resolveProposal(
  runtime: ProjectRuntime, record: OperationIdentityRecordV1, access: RecordingCompileAccess, fence: PolicyFence,
): Promise<ResolvedPublication> {
  const control = await runtime.control.loadProject(runtime.principal.project);
  if (control === null) throw new PortableDenied();
  const labels = [control.compartment];
  const { allowed, skipped } = await partitionByFloor(access.candidates);
  const candidates = [];
  for (const candidate of allowed) {
    candidates.push({ candidate, pre: await targetPreimage(runtime, access, candidate, labels) });
  }
  const { writes, receipt, dependencies } = buildProposalBatch({
    operationId: record.operationId, intentDigest: record.intentDigest, candidates, skipped,
    dependencies: dependenciesFrom(access), labels,
  });
  await validateDependencies(runtime.store, dependencies);
  return {
    writes, tail: [], skipped, onBehalfOf: [], proposal: receipt,
    // The fence generation started under; `submit` refuses `policy_changed` if base policy moved since.
    policyFence: fence, consumedApprovalId: null, consumedTicketId: null,
  };
}

/**
 * A generation that failed, as the typed refusal step 3 records.
 * Exported for a caller that runs step 2 itself between its own begin and persist. A refusal
 * passes through. Any other error (a provider fault, a parser bug) is audited
 * with its true reason and closed as a recorded refusal, so it never rejects
 * the call while leaving an in-progress lease behind.
 */
function generationFailure(runtime: ProjectRuntime, request: OperationRequest, error: unknown): PortableRefusal {
  if (error instanceof PortableRefusal) return error;
  runtime.control.audit({ kind: "generation-failed", operationId: request.operationId, error: String(error) });
  return new PortableRefusal("operation_unsupported_on_portable_path", "generation failed");
}

/** A late finisher's outcome: superseded, writing nothing. A fresh object each time. */
function superseded(): ProposalOutcome {
  return { kind: "rejected", reason: "generation_superseded" };
}

/** Whether `beforeEffect` (asked once, when given) still admits this generation's custody; absent, it always does. */
async function holdsCustody(steps: Pick<GenerationSteps<unknown>, "beforeEffect">): Promise<boolean> {
  return steps.beforeEffect === undefined || (await steps.beforeEffect());
}

/** Settle `code` as this operation's recorded refusal, unless custody was lost: a superseded late finisher writes nothing. */
async function settleRefusal(
  runtime: ProjectRuntime, record: OperationIdentityRecordV1, steps: Pick<GenerationSteps<unknown>, "beforeEffect">, code: RefusalCode,
): Promise<ProposalOutcome> {
  if (!(await holdsCustody(steps))) return superseded();
  return (await refuse(runtime, record, code)) as ProposalOutcome;
}

/**
 * Resolve what was generated and submit it under the custody and publication
 * guards. A withdrawn publication is superseded; a refusal from resolve or
 * submit is settled; any other error propagates.
 */
async function resolveAndSubmit<A>(
  runtime: ProjectRuntime, record: OperationIdentityRecordV1, generated: A, fence: PolicyFence, steps: GenerationSteps<A>,
): Promise<ProposalOutcome> {
  try {
    const resolved = await steps.resolve(record, generated, fence);
    if (!(await holdsCustody(steps))) return superseded();
    const guards = { beforePublish: steps.beforePublish, beforeRefusal: steps.beforeEffect, finalSync: steps.finalSync };
    return (await submit(runtime, record, resolved, guards)) as ProposalOutcome;
  } catch (error) {
    if (error instanceof PublishWithdrawn) return superseded();
    if (error instanceof PortableRefusal) return settleRefusal(runtime, record, steps, error.code);
    throw error;
  }
}

/**
 * STEP 3, under the gate the caller holds: persist — or reject a late finisher.
 * In order: recovery, the in-progress record under this epoch, a generation
 * failure settled, admission re-checked at the effect, then resolve and submit.
 */
async function persistGenerationLocked<A>(
  runtime: ProjectRuntime, request: OperationRequest, begun: Extract<Begun, { kind: "proceed" }>,
  generated: A | PortableRefusal, steps: GenerationSteps<A>,
): Promise<ProposalOutcome> {
  const auth: Authority = runtime;
  await recoverLocked(auth);
  const lease = { operationId: request.operationId, epoch: begun.epoch, owner: begun.owner, fence: begun.fence };
  const record = await heldRecord(runtime, request, lease);
  if (record === null) return superseded();
  if (generated instanceof PortableRefusal) return settleRefusal(runtime, record, steps, generated.code);
  // Re-checked at the effect: a role revoked while the model ran is gone, and an
  // intent parked meanwhile blocks this proposal like any other write.
  const blocked = await effectRefusal(runtime, request, steps.extraCheck);
  if (blocked !== null) return settleRefusal(runtime, record, steps, blocked);
  return resolveAndSubmit(runtime, record, generated, begun.fence, steps);
}

/**
 * Propose changes by running the real review-mode compile inside the host.
 * A same-id retry of a committed proposal returns the recorded proposal and
 * does not run the model again.
 */
export async function propose(runtime: ProjectRuntime, request: ProposeRequest): Promise<ProposalOutcome> {
  await authorize(runtime.control, runtime.principal, "compile.propose");
  // The offline fixture changes what answers the model call, not who may make it.
  await authorize(runtime.control, runtime.principal, "model.invoke");
  const supersedes = request.supersedes ?? null;
  const operation: OperationRequest = {
    operationId: request.operationId, kind: "proposal.persist", supersedes, requires: ["compile.propose", "model.invoke"],
    intentDigest: intentDigestOf(runtime.principal, "proposal.persist", request.operationId, supersedes, { scope: null }),
  };
  return runGeneratedProposal(runtime, operation, {
    // Refused by name, as a recorded outcome, before the model is allowed to run.
    extraCheck: () => v1WriteRefusal(runtime),
    generate: () => generate(runtime),
    resolve: (record, access, fence) => resolveProposal(runtime, record, access, fence),
  });
}

/** `capability_unsupported` when the project has adopted a format version 1 writes would bypass, else `null`. */
export async function v1WriteRefusal(runtime: ProjectRuntime): Promise<RefusalCode | null> {
  return (await runtime.store.formatRefusesV1?.()) === true ? "capability_unsupported" : null;
}

/**
 * The three-step proposal protocol over any generation: lease under the gate,
 * generate outside it, persist under it again. A same-id retry of a committed
 * proposal returns the recorded proposal and does not generate again.
 */
export async function runGeneratedProposal<A>(
  runtime: ProjectRuntime, operation: OperationRequest, steps: GenerationSteps<A>,
): Promise<ProposalOutcome> {
  const begun = await runtime.store.withGate(() => beginGenerationLocked(runtime, operation, steps));
  if (begun.kind === "settled") return begun.outcome;
  const lease: GenerationLease = { operationId: operation.operationId, epoch: begun.epoch, owner: begun.owner, fence: begun.fence };
  const generated = await steps.generate(lease).catch((error: unknown) => generationFailure(runtime, operation, error));
  return runtime.store.withGate(() => persistGenerationLocked(runtime, operation, begun, generated, steps));
}

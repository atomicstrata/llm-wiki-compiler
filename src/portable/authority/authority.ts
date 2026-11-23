/**
 * @file src/portable/authority/authority.ts
 * @description The publication authority: the ONE protocol every authoritative
 * write goes through — a source add, a proposal, an approval and an apply.
 *
 * The order of its steps is what makes a retry safe:
 *
 *  1. the identity record is consulted FIRST, by operation id, before anything
 *     is resolved, read or generated. A same-id, same-intent retry gets the
 *     recorded state back and causes nothing; a same id with a different intent
 *     is a rejection of that submission and leaves the recorded operation alone;
 *  2. an in-progress record is written;
 *  3. only then is the operation resolved (dependencies, targets, labels, fence);
 *  4. the store publishes the batch with its receipt.
 *
 * A refusal leaves no effect and is recorded. An outcome that cannot be
 * established is reported as `unknown` and left for recovery — it is never
 * collapsed into success or failure.
 */

import type {
  ContentDigest,
  OperationIdentityRecordV1,
  OperationKind,
  Permission,
  PrincipalContext,
  PublicationStatus,
  ReceiptV1,
  RefusalCode,
  SkippedItem,
  SubmissionRejected,
} from "../contracts.js";
import { bytesDigest, recordDigest } from "../digest.js";
import { PortableRefusal } from "../errors.js";
import { isOperationIdValid } from "../host/operation-ids.js";
import { entitlementOf, isCleared } from "../host/policy.js";
import { missingPublicationCapability, type StoredWrite, type TailWrite } from "../store/store.js";
import { recoverLocked, statusOf, type Authority } from "./status.js";

/** What a caller asked for, reduced to what idempotency compares. */
export interface OperationRequest {
  operationId: string;
  kind: OperationKind;
  /** Caller-stable: covers only inputs the caller holds. The idempotency key. */
  intentDigest: ContentDigest;
  supersedes: string | null;
  /**
   * The verbs the executing identity must hold AT THE EFFECT. A session only
   * establishes who is calling; the authority checks these itself, under the
   * gate, against current host state, immediately before it resolves anything.
   */
  requires: readonly Permission[];
}

/**
 * True when the executing identity holds every required verb right now, and
 * with it clearance for the project compartment every J1 object carries.
 */
export async function holdsAtEffect(
  auth: Authority, principal: PrincipalContext, requires: readonly Permission[],
): Promise<boolean> {
  const control = await auth.control.loadProject(principal.project);
  if (control === null) return false;
  const held = entitlementOf(control, principal.actor);
  return requires.every((permission) => held.permissions.has(permission)) && isCleared(held.clearances, [control.compartment]);
}

/** Everything the host worked out for one operation, ready to publish. */
export interface ResolvedPublication {
  writes: readonly StoredWrite[];
  tail: readonly TailWrite[];
  skipped: readonly SkippedItem[];
  onBehalfOf: readonly string[];
  /** The fence the operation was resolved under; re-checked at commit. */
  policyFence: { policyRevision: number; ticketRevision: number };
  consumedApprovalId: string | null;
  consumedTicketId: string | null;
  proposal?: ReceiptV1["proposal"];
  approval?: ReceiptV1["approval"];
}

/** What `begin` decided for one submission. */
export type BeginResult =
  | { kind: "proceed"; record: OperationIdentityRecordV1 }
  | { kind: "settled"; status: PublicationStatus | SubmissionRejected };

/** A fresh in-progress identity record. */
function newIdentity(auth: Authority, principal: PrincipalContext, request: OperationRequest): OperationIdentityRecordV1 {
  return {
    tenant: principal.tenant, project: principal.project, actor: principal.actor,
    hostIncarnation: auth.control.incarnation, kind: request.kind, operationId: request.operationId,
    intentDigest: request.intentDigest, outcome: "in-progress", refusal: null, detail: null,
    holds: { approvalId: null, ticketId: null }, generationLease: null, resolution: null,
    supersedes: request.supersedes,
  };
}

/** Record a terminal refusal and return its status. */
export async function refuse(
  auth: Authority, record: OperationIdentityRecordV1, code: RefusalCode,
): Promise<PublicationStatus> {
  const refused = { ...record, outcome: "refused" as const, refusal: code, generationLease: null };
  await auth.store.putIdentity(refused);
  return statusOf(auth, refused);
}

/** A `supersedes` link is honoured only for a terminal refusal of the same actor. */
async function supersedesIsValid(auth: Authority, principal: PrincipalContext, supersedes: string): Promise<boolean> {
  const named = await auth.store.getIdentity(supersedes);
  return named !== null && named.outcome === "refused" && named.actor === principal.actor;
}

/**
 * STEP 1, under the gate, before anything is resolved or generated: look the
 * operation up by id and decide whether this submission proceeds.
 */
export async function begin(
  auth: Authority, principal: PrincipalContext, request: OperationRequest,
): Promise<BeginResult> {
  if (!isOperationIdValid(auth.control, principal, request.operationId)) {
    return { kind: "settled", status: { kind: "rejected", reason: "operation_id_not_valid" } };
  }
  const existing = await auth.store.getIdentity(request.operationId);
  if (existing) return { kind: "settled", status: await reconcile(auth, existing, request) };
  const record = newIdentity(auth, principal, request);
  // A parked intent blocks every further write until it is resolved. The refusal
  // is a recorded, known no-effect outcome of THIS id; once the project is
  // usable again the caller submits a new operation that supersedes it.
  if ((await auth.store.unresolvedIntents()).length > 0) {
    return { kind: "settled", status: await refuse(auth, record, "recovery_blocking") };
  }
  if (request.supersedes !== null && !(await supersedesIsValid(auth, principal, request.supersedes))) {
    return { kind: "settled", status: await refuse(auth, record, "supersedes_invalid") };
  }
  await auth.store.putIdentity(record);
  return { kind: "proceed", record };
}

/** A second submission under an existing id: the recorded state, or a rejection. */
async function reconcile(
  auth: Authority, existing: OperationIdentityRecordV1, request: OperationRequest,
): Promise<PublicationStatus | SubmissionRejected> {
  if (existing.intentDigest !== request.intentDigest || existing.kind !== request.kind) {
    return { kind: "rejected", reason: "operation_id_in_use" };
  }
  return statusOf(auth, existing);
}

/** The commit record for one resolved publication. */
function receiptFor(record: OperationIdentityRecordV1, resolved: ResolvedPublication): ReceiptV1 {
  const published = resolved.writes.map((write) => ({
    path: write.path, digest: bytesDigest(write.bytes), labels: write.labels,
  }));
  const plan = { published, skipped: resolved.skipped, fence: resolved.policyFence };
  return {
    project: record.project, revision: null, operationId: record.operationId, kind: record.kind,
    intentDigest: record.intentDigest, resolvedPlanDigest: recordDigest(plan), actor: record.actor,
    onBehalfOf: resolved.onBehalfOf, policyFence: resolved.policyFence, published,
    skipped: resolved.skipped, consumedApprovalId: resolved.consumedApprovalId,
    consumedTicketId: resolved.consumedTicketId, committedAt: new Date().toISOString(),
    ...(resolved.proposal ? { proposal: resolved.proposal } : {}),
    ...(resolved.approval ? { approval: resolved.approval } : {}),
  };
}

/**
 * A caller's last word before `submit` publishes, asked after its own fence
 * check: `null` proceeds, `"withdrawn"` writes nothing at all, and a refusal
 * code is recorded as the operation's refusal.
 */
export type PublishGuard = () => Promise<RefusalCode | "withdrawn" | null>;

/**
 * A caller's SYNCHRONOUS last word, asked after every await of `submit` and
 * immediately before the store's publish is called: there is no await between
 * its answer and that call, so on a store whose publish swaps its head before
 * yielding, nothing can move between this check and the commit.
 */
export type FinalSyncGuard = () => RefusalCode | "withdrawn" | null;

/**
 * Optional guards on `submit`'s effects. `beforePublish` is the last await
 * before the publish; `finalSync` follows it with no await at all;
 * `beforeRefusal` is asked before EVERY refusal `submit` would record — its
 * own early ones included — and `false` withdraws it. Absent, `submit`
 * behaves exactly as before.
 */
export interface SubmitGuards { beforePublish?: PublishGuard; beforeRefusal?: () => Promise<boolean>; finalSync?: FinalSyncGuard }

/**
 * The guards a non-generation write ({@link runOperation}) may carry. The
 * caller holds the gate from begin to commit, so they can only REFUSE: a
 * withdrawal would strand an in-progress identity and anything it reserved.
 */
export interface RunGuards { beforePublish?: () => Promise<RefusalCode | null>; finalSync?: () => RefusalCode | null }

/** Thrown by `submit` when its publish guard withdrew: nothing was written. */
export class PublishWithdrawn extends Error {
  constructor(readonly operationId: string) { super(`publication withdrawn: ${operationId}`); }
}

/** Re-check the fence in the same gate hold that accepts the commit. */
async function fenceStillHolds(auth: Authority, record: OperationIdentityRecordV1, resolved: ResolvedPublication): Promise<boolean> {
  const current = await auth.control.loadProject(record.project);
  return current !== null && current.policyRevision === resolved.policyFence.policyRevision;
}

/**
 * STEP 2, only after `begin` said proceed and the host resolved the operation:
 * check capabilities and the fence, publish, and record the outcome. Optional
 * `guards` stand before each effect (see {@link SubmitGuards}); absent,
 * nothing changes.
 *
 * @throws PublishWithdrawn when a guard withdrew; nothing was written.
 */
export async function submit(
  auth: Authority, record: OperationIdentityRecordV1, resolved: ResolvedPublication, guards: SubmitGuards = {},
): Promise<PublicationStatus> {
  const refuseGuarded = async (code: RefusalCode): Promise<PublicationStatus> => {
    if (guards.beforeRefusal !== undefined && !(await guards.beforeRefusal())) throw new PublishWithdrawn(record.operationId);
    return refuse(auth, record, code);
  };
  if (missingPublicationCapability(auth.store, resolved.writes.length) !== null) return refuseGuarded("capability_unsupported");
  if (!(await fenceStillHolds(auth, record, resolved))) return refuseGuarded("policy_changed");
  const verdict = guards.beforePublish === undefined ? null : await guards.beforePublish();
  if (verdict === "withdrawn") throw new PublishWithdrawn(record.operationId);
  if (verdict !== null) return refuseGuarded(verdict);
  // After the last await: nothing but synchronous work stands between this answer and the publish call.
  const last = guards.finalSync?.() ?? null;
  if (last === "withdrawn") throw new PublishWithdrawn(record.operationId);
  if (last !== null) return refuseGuarded(last);
  const receipt = receiptFor(record, resolved);
  try {
    await auth.store.publish({
      operationId: record.operationId, kind: record.kind, writes: resolved.writes, receipt, tail: resolved.tail,
    });
  } catch (error) {
    if (error instanceof PortableRefusal) return refuseGuarded(error.code);
    // The write may or may not have landed. Say so, and leave it for recovery.
    auth.control.audit({ kind: "publish-unknown", operationId: record.operationId, error: String(error) });
    return { kind: "unknown", operationId: record.operationId };
  }
  const committed = { ...record, outcome: "committed" as const, generationLease: null };
  await auth.store.putIdentity(committed);
  return statusOf(auth, committed);
}

/**
 * Run one non-generation write in ONE continuous hold of the gate: recover,
 * begin, resolve, submit. Nothing else can interleave with a half-begun operation.
 *
 * @param resolve - Resolves the operation; throws {@link PortableRefusal} to refuse it.
 * @param admit - Optional: a path's own answer for a NEW operation that must not even begin
 *   (it records no identity). Omitted for every version 1 write.
 * @param guards - Optional refusal-only guards passed to `submit`. Omitted for every existing write.
 */
export async function runOperation<A = never>(
  auth: Authority,
  principal: PrincipalContext,
  request: OperationRequest,
  resolve: (record: OperationIdentityRecordV1) => Promise<ResolvedPublication>,
  admit?: () => Promise<A | null>,
  guards: RunGuards = {},
): Promise<PublicationStatus | SubmissionRejected | A> {
  return auth.store.withGate(async () => {
    await recoverLocked(auth);
    // A path's own admission (S3: resolving a staged handle) runs only for a NEW operation id, in the
    // same gate hold, so a retry of a recorded operation returns its recorded outcome first.
    const isNew = (await auth.store.getIdentity(request.operationId)) === null;
    const declined = isNew && admit !== undefined ? await admit() : null;
    if (declined !== null) return declined;
    const begun = await begin(auth, principal, request);
    if (begun.kind === "settled") return begun.status;
    if (!(await holdsAtEffect(auth, principal, request.requires))) {
      return refuse(auth, begun.record, "permission_denied");
    }
    let resolved: ResolvedPublication;
    try {
      resolved = await resolve(begun.record);
    } catch (error) {
      if (error instanceof PortableRefusal) return refuse(auth, begun.record, error.code);
      throw error;
    }
    return submit(auth, (await auth.store.getIdentity(request.operationId)) ?? begun.record, resolved, guards);
  });
}

/** The intent digest of one request: project, kind, id, supersedes and the kind's own payload. */
export function intentDigestOf(
  principal: PrincipalContext, kind: OperationKind, operationId: string, supersedes: string | null, payload: unknown,
): ContentDigest {
  return recordDigest({ project: principal.project, kind, operationId, supersedes, payload });
}

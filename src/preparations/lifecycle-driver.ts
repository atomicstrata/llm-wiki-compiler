/**
 * @file src/preparations/lifecycle-driver.ts
 * @description The one operation driver for byte-preserving custody (design V1
 * §10.1, PLA-INV-07).
 *
 * Before Task 9D, per-run quarantine and project reset each reached the two-phase
 * custody protocol directly and drove its phases themselves. PLA-INV-07 forbids
 * that — "operation-specific adapters cannot invent their own
 * plan/apply/verify/complete protocol" — so the sequence lives here once and the
 * operations become adapters.
 *
 * The split follows design V1 §10.1. The DRIVER owns the phase ORDERING, and the
 * two-phase protocol itself — receipt creation and verification, crash-state
 * classification, durable ordering and fsync — remains inside
 * `runTwoPhaseQuarantine`, which this module wraps rather than reimplements.
 * Rewriting a proven two-phase protocol to prove it is now owned would be the
 * more dangerous change.
 *
 * Stated precisely, because an earlier version of this comment claimed more than
 * is true: per-object observation is NOT in the engine. The `byteCount` and
 * `digest` the receipt attests come from `captureLifecycleScopedObject`, called
 * inside the ADAPTER's `assess` (see `quarantine.ts`), and the engine only
 * copies those values. Terminal eligibility — purge, and the started/pending
 * questions — likewise lives in the adapters. PLA-MAP-S06 records this
 * correctly; the docblock did not.
 *
 * ADAPTERS own only what genuinely differs: read-only eligibility plus the plan
 * draft (`assess`), and key materialization (`materialize`). The split exists
 * because reset publishes an epoch, which cannot happen inside a read lease and
 * is itself a permit-protected mutation under design V2 §9.2.
 *
 * The custody input is assembled field by field rather than by spreading the
 * adapter's plan, so an adapter cannot introduce a field the driver did not name.
 */

import { evaluateDestructiveAuthorization } from "../operation-bundles/lock-gate.js";
import type { LifecycleAuthorizationV1, LifecycleGateTicketV1 } from "../operation-bundles/lock-gate.js";
import { projectLifecyclePending } from "./lifecycle-snapshot/compat.js";
import {
  mintLifecycleMutationPermit, type LifecycleMutationPermitV1,
} from "./lifecycle-mutation-permit.js";
import { canonicalPreparationRootIdentity } from "./lifecycle-fs/namespace.js";
import {
  withPreparationLifecycleRead, type PreparationLifecycleReadV1,
} from "./lifecycle-snapshot/read.js";
import { runTwoPhaseQuarantine, type QuarantineMoveFaultsForTest, type ScopedQuarantineObject } from "./quarantine-move.js";
import { runTwoPhaseVerifiedDelete, type DeleteFaultsForTest } from "./prune-delete.js";
import { destroySettledQuarantineUnit } from "./quarantine-destroy.js";
import type {
  PruneReceiptContentV1, PruneReceiptV1,
  QuarantineReason, QuarantineReceiptV1, QuarantineScope, RetiredQuarantineUnitV1,
} from "./receipts.js";
import type { PreparationPrincipalV1 } from "./run-types.js";

/** The governing key epoch an adapter resolved for this operation. */
export interface LifecycleGoverningKey {
  readonly key: Buffer;
  readonly keyEpochId: string;
}

/** Everything every custody operation supplies, whatever its own input shape. */
export interface LifecycleCustodyRequest {
  readonly actor: PreparationPrincipalV1;
  readonly at: string;
  /**
   * The gate decision this operation acts under, or an explicit `"ungated"`.
   *
   * REQUIRED, AND EXPLICIT, because the alternative is the defect this field
   * exists to close. An OPTIONAL authorization is the same shape as the
   * `resumed: boolean` it replaces — it makes re-checking nothing the path of
   * least resistance, and a future gated executor that simply omits it would
   * skip re-evaluation silently. Three of this driver's five callers hold no
   * ticket; they must SAY so rather than leave a field out.
   */
  readonly authorization: LifecycleAuthorizationV1 | "ungated";
  /**
   * Test-only crash seams. The UNION because the two engines place their seams at
   * different boundaries -- a move has no staging step, a delete has no move --
   * and pretending one shape fits both would silently drop the seams the delete
   * engine's resume tests depend on.
   */
  readonly faults?: QuarantineMoveFaultsForTest | DeleteFaultsForTest;
}

/**
 * The object set and attestation an adapter constructs from the complete
 * snapshot. Exactly the fields an operation may vary — anything absent here is
 * the driver's to decide, not the adapter's.
 *
 * DISCRIMINATED, from Task 9E, because two engines now exist and they need
 * different fields. A generic plan would have destroyed the control stated at the
 * top of this file — that the driver assembles the engine input field by field so
 * an adapter cannot introduce a field the driver did not name. Here the driver
 * still names every field; what became plural is the number of field lists, not
 * their authorship. `never` exhaustiveness on the discriminant makes a new kind a
 * compile error rather than an unsealed plan.
 */
export interface LifecycleCustodyMovePlan {
  readonly kind: "custody-move";
  readonly unitId: string;
  readonly scope: QuarantineScope;
  readonly reason: QuarantineReason;
  readonly runId?: string;
  readonly objects: readonly ScopedQuarantineObject[];
  readonly residualObligations: readonly string[];
  /** Superseded-epoch units this receipt attests as retired (project reset only). */
  readonly retiredUnits?: readonly RetiredQuarantineUnitV1[];
}

/** A delete plan has no scope, reason, residual set, or retirement attestation. */
export interface LifecycleVerifiedDeletePlan {
  readonly kind: "verified-delete";
  readonly unitId: string;
  readonly operation: PruneReceiptContentV1["operation"];
  readonly runId?: string;
  readonly objects: readonly ScopedQuarantineObject[];
}

/**
 * Purge: destroy the bytes a COMPLETED quarantine receipt already attests.
 *
 * It mints no plan of its own, and that is design conformance rather than a
 * shortcut (§10.2: "the already authenticated completed quarantine receipt is the
 * sealed plan. Purge does not create a second durable intent or completion
 * record"). A second durable record would be new intermediate state needing its
 * own crash classification, and two records stating one fact would then need a
 * control comparing them.
 */
export interface LifecycleVerifiedDestroyPlan {
  readonly kind: "verified-destroy";
  readonly unitId: string;
  /**
   * The SETTLED RECEIPT'S OWN OBJECTS, not a re-derived set. Two lists stating
   * one fact would need a control comparing them; there is one list.
   */
  readonly objects: QuarantineReceiptV1["objects"];
  /** The authenticated receipt that IS this plan, returned as the tombstone. */
  readonly settled: QuarantineReceiptV1;
}

export type LifecycleCustodyPlan =
  | LifecycleCustodyMovePlan
  | LifecycleVerifiedDeletePlan
  | LifecycleVerifiedDestroyPlan;

export type LifecyclePlanKind = LifecycleCustodyPlan["kind"];

type PlanOfKind<K extends LifecyclePlanKind> = Extract<LifecycleCustodyPlan, { kind: K }>;

/**
 * The receipt each engine produces, bound to its plan kind BY THE COMPILER.
 *
 * An adapter declaring `planKind: "verified-delete"` cannot return or consume a
 * `QuarantineReceiptV1`. The two registries stay separate (design §18 excludes
 * combining them), so the binding is what stops a future edit from quietly
 * crossing them.
 */
export type LifecycleReceiptOfKind<K extends LifecyclePlanKind> =
  K extends "verified-delete" ? PruneReceiptV1 : QuarantineReceiptV1;

/** What one read-only assessment produced. */
export interface LifecycleCustodyAssessment<K extends LifecyclePlanKind = "custody-move"> {
  /** The sealed plan draft. Nothing may change it once the lease closes. */
  readonly draft: PlanOfKind<K>;
  /**
   * The governing key, when it already exists and needs no materialization.
   * Absent for a reset that must still mint its epoch.
   */
  readonly key?: LifecycleGoverningKey;
}

/** One custody operation, expressed as the phases that genuinely differ. */
export interface LifecycleCustodyAdapter<
  TInput extends LifecycleCustodyRequest,
  K extends LifecyclePlanKind = "custody-move",
> {
  /** Operation name, for diagnostics, ownership controls, and permit binding. */
  readonly operation: LifecycleMutationPermitV1["operation"];
  /** Which engine the driver runs. Selected here, never supplied as a callback. */
  readonly planKind: K;
  /**
   * READ-ONLY. Eligibility and the plan draft. Throws the operation's own typed
   * refusal; the driver never reinterprets it, so each operation keeps its exact
   * refusal vocabulary.
   *
   * This ALWAYS runs inside the driver's lifecycle read lease — there is no
   * opt-out, and the capture is never null. Eligibility is decided from it;
   * anything the snapshot cannot carry (key BYTES, receipt BYTES) is read
   * separately and is the recorded 9E debt, not a licence to skip the capture.
   *
   * It must not mutate, which is why reset's key materialization is
   * a separate phase: publishing an epoch inside a read lease would be a
   * category error, and the lease invalidates as soon as this returns.
   */
  assess(
    root: string, input: TInput, read: PreparationLifecycleReadV1,
  ): Promise<LifecycleCustodyAssessment<K>>;
  /**
   * MAY MUTATE, under the driver-minted permit. Reset materializes its epoch
   * here — moving old-key custody, staging the pending key, and publishing it.
   * Quarantine has nothing to materialize and returns the key it already read.
   */
  materialize(
    root: string, input: TInput, assessment: LifecycleCustodyAssessment<K>,
    permit: LifecycleMutationPermitV1,
  ): Promise<LifecycleGoverningKey>;
  /**
   * OPTIONAL, MAY MUTATE, under the same permit. Work that must happen only once
   * the custody receipt is durable — reset removes its crash-resumption material
   * here.
   *
   * It exists because the caller was doing this itself after the driver returned,
   * outside both the driver's phase ordering and the permit contract, while
   * destroying exactly the material a crash would need. A phase the driver owns
   * and permits is the difference between "the operation completed" and "someone
   * deleted the recovery state afterwards".
   */
  complete?(
    root: string, input: TInput, receipt: LifecycleReceiptOfKind<K>,
    permit: LifecycleMutationPermitV1,
  ): Promise<void>;
}

/**
 * Project roots with a custody operation currently in flight.
 *
 * PLA-INV-07 says an adapter may not drive its own plan/apply/verify/complete
 * sequence, and review showed the driver let it do exactly that by the back
 * door: a `materialize` that called back into the driver ran a COMPLETE second
 * operation — its own minted permit, its own signed receipt — nested inside the
 * first, which then went on to finish normally.
 *
 * Keyed BY ROOT, not process-global. The first version was a single boolean held
 * across awaits, which banned concurrency rather than re-entrancy: two unrelated
 * projects running at once refused each other, with a message describing a
 * nesting that had not happened. Harmless in a single-root CLI, wrong in any
 * process serving several roots — the SDK and the MCP server both do.
 *
 * Entries are removed in a `finally`, so a refusing operation does not wedge the
 * next one on that root.
 */
const custodyOperationsInFlight = new Set<string>();

/**
 * Freeze the draft, the arrays it carries, AND their elements.
 *
 * Freezing only the arrays left every field the receipt actually attests still
 * writable — `logicalPath`, `byteCount` and `digest` on each planned object, and
 * `unitId`/`receiptDigest` on each retired unit all live on the elements. A frozen
 * array of mutable objects is not a sealed plan, and `materialize` receives the
 * whole assessment after the lease has closed.
 */
/** Freeze the fields only a custody-move plan has. */
function sealCustodyMoveFields(draft: LifecycleCustodyMovePlan): void {
  Object.freeze(draft.residualObligations);
  if (draft.retiredUnits === undefined) return;
  for (const unit of draft.retiredUnits) Object.freeze(unit);
  Object.freeze(draft.retiredUnits);
}

/**
 * Freeze the settled receipt a destroy plan carries, ELEMENT-WISE.
 *
 * The same depth the custody-move branch applies to the same receipt shape. A
 * shallow freeze here left `actor`, `residualObligations` and `retiredUnits`
 * writable -- defence in depth strictly weaker than the branch it was modelled
 * on, for no reason, and with no test until review mutation-tested it.
 */
function sealSettledReceipt(receipt: QuarantineReceiptV1): void {
  for (const object of receipt.objects) Object.freeze(object);
  Object.freeze(receipt.objects);
  Object.freeze(receipt.actor);
  if (receipt.residualObligations !== undefined) Object.freeze(receipt.residualObligations);
  if (receipt.retiredUnits !== undefined) {
    for (const unit of receipt.retiredUnits) Object.freeze(unit);
    Object.freeze(receipt.retiredUnits);
  }
  Object.freeze(receipt);
}

function sealCustodyPlan<P extends LifecycleCustodyPlan>(draft: P): P {
  for (const object of draft.objects) Object.freeze(object);
  Object.freeze(draft.objects);
  if (draft.kind === "custody-move") sealCustodyMoveFields(draft);
  else if (draft.kind === "verified-destroy") sealSettledReceipt(draft.settled);
  else if (draft.kind !== "verified-delete") {
    // EXHAUSTIVENESS, not decoration. A new plan kind added without a freeze
    // branch would otherwise seal only `objects` and leave its own fields
    // writable after the lease closed -- the exact defect the element-wise freeze
    // was added to fix. This makes that a compile error.
    const unsealed: never = draft;
    throw new Error(`unsealed lifecycle plan kind: ${JSON.stringify(unsealed)}`);
  }
  return Object.freeze(draft);
}

/**
 * Finish an operation whose custody receipt is ALREADY durable.
 *
 * The idempotent-resume path finds a completed reset and still has crash material
 * to clear. There is no custody sequence left to run, but the cleanup is a
 * permit-gated mutation all the same — so the driver mints for it here rather
 * than letting a caller mint, which would defeat the control asserting that only
 * declared driver modules reach the minting seam.
 */
export async function completeLifecycleCustodyOperation<TInput extends LifecycleCustodyRequest>(
  root: string,
  adapter: LifecycleCustodyAdapter<TInput>,
  input: TInput,
  receipt: QuarantineReceiptV1,
  unitId: string,
): Promise<void> {
  const permit = mintLifecycleMutationPermit(adapter.operation, unitId);
  await adapter.complete?.(root, input, receipt, permit);
}

/**
 * Run one byte-preserving custody operation through the common driver.
 *
 * Three phases, in this order for reasons the design fixes:
 *
 * 1. ONE read-only capture, made available to eligibility and planning, and
 *    closed before anything mutates.
 *
 *    Stated precisely, because the stronger claim is not yet true: the lease
 *    BOUNDS the assessment in time; it does not yet UNIFY it. `assess` still
 *    performs independent root-taking observations inside the lease — the key
 *    read, the destructive traversal, per-unit receipt reads. What the capture
 *    genuinely supplies today is the retirement-set unit listing, which no longer
 *    re-enumerates the registry. Collapsing the remainder onto one capture is the
 *    `9D/9E-destructive-traversal` obligation already recorded against
 *    `quarantine.ts` and `retention.ts`, not something this task completed.
 * 2. Mint the operation-bound permit, then materialize. Reset publishes its epoch
 *    here — a permit-protected mutation in its own right (design V2 §9.2), not
 *    eligibility work.
 * 3. The custody engine, carrying the SAME sealed draft and the SAME permit, so
 *    what was planned under the capture is exactly what is applied.
 */
export async function runLifecycleCustodyOperation<
  TInput extends LifecycleCustodyRequest, K extends LifecyclePlanKind,
>(
  root: string,
  adapter: LifecycleCustodyAdapter<TInput, K>,
  input: TInput,
): Promise<LifecycleReceiptOfKind<K>> {
  // BEFORE THE FIRST AWAIT. An earlier version copied these after `assess`
  // resolved, which left the whole asynchronous assessment as a mutation window:
  // review reproduced changing `actor` and `at` while assess was pending, and the
  // signed receipt carried the mutated identity and timestamp. The copy is
  // synchronous and happens before anything can interleave, and the adapter is
  // handed THIS value, so it never observes the caller's mutable object.
  const sealed = sealCustodyRequest(input);
  // CANONICAL, not the caller's string. Keying on the raw root let `root + "/"`
  // — or any alias, `.`/`..` segment, or symlinked path — open a second
  // concurrent operation on the same project with the guard none the wiser.
  // Resolution happens before the check, and the has/add pair stays synchronous
  // and adjacent, so no second caller can interleave between them.
  const canonicalRoot = await canonicalPreparationRootIdentity(root);
  if (custodyOperationsInFlight.has(canonicalRoot)) {
    throw new Error(`a custody operation is already in flight for ${canonicalRoot}; the driver is not re-entrant`);
  }
  custodyOperationsInFlight.add(canonicalRoot);
  try {
    // The `await` is LOAD-BEARING: without it the `finally` releases the root
    // before the operation settles and the guard stops guarding. Lint rules that
    // flag `return await` will tell you to delete it. Do not — a test pins this.
    return await driveCustodyOperation(root, adapter, sealed);
  } finally {
    custodyOperationsInFlight.delete(canonicalRoot);
  }
}

/**
 * Copy every field the receipt attests, synchronously.
 *
 * `actor` is copied by VALUE because copying the reference let an adapter mutate
 * `actor.id` in place; the spread captures the adapter's own fields at this
 * instant so a later mutation of the caller's object cannot reach the operation.
 */
function sealCustodyRequest<TInput extends LifecycleCustodyRequest>(input: TInput): TInput {
  return Object.freeze({
    ...input,
    actor: Object.freeze({ id: input.actor.id, surface: input.actor.surface }),
    at: input.at,
  });
}

/**
 * The driver-owned engine map: plan kind -> terminal engine.
 *
 * ENUMERATED HERE, never supplied by the adapter. A callback parameter would hand
 * the adapter back the ability to choose its own protocol, which is precisely the
 * PLA-INV-07 violation this driver exists to close -- an adapter could satisfy the
 * type and still drive its own plan/apply/verify/complete sequence.
 *
 * Each branch assembles its engine's input FIELD BY FIELD from the sealed plan.
 * That is the same control the single-engine version had, applied twice: an
 * adapter still cannot introduce a field the driver did not name.
 */
/** The custody-move engine input, named field by field. */
async function runCustodyMove(
  root: string,
  plan: LifecycleCustodyMovePlan,
  key: LifecycleGoverningKey,
  permit: LifecycleMutationPermitV1,
  attested: { actor: PreparationPrincipalV1; at: string; faults?: QuarantineMoveFaultsForTest | DeleteFaultsForTest },
): Promise<QuarantineReceiptV1> {
  return runTwoPhaseQuarantine({
    permit,
    root,
    unitId: plan.unitId,
    scope: plan.scope,
    reason: plan.reason,
    ...(plan.runId === undefined ? {} : { runId: plan.runId }),
    key: key.key,
    keyEpochId: key.keyEpochId,
    actor: attested.actor,
    at: attested.at,
    objects: plan.objects,
    residualObligations: plan.residualObligations,
    ...(plan.retiredUnits === undefined ? {} : { retiredUnits: plan.retiredUnits }),
    ...(attested.faults === undefined ? {} : { faults: attested.faults as QuarantineMoveFaultsForTest }),
  });
}

async function runPlanEngine(
  root: string,
  plan: LifecycleCustodyPlan,
  key: LifecycleGoverningKey,
  permit: LifecycleMutationPermitV1,
  attested: { actor: PreparationPrincipalV1; at: string; faults?: QuarantineMoveFaultsForTest | DeleteFaultsForTest },
): Promise<QuarantineReceiptV1 | PruneReceiptV1> {
  if (plan.kind === "custody-move") return runCustodyMove(root, plan, key, permit, attested);
  if (plan.kind === "verified-destroy") {
    await destroySettledQuarantineUnit({
      permit, root, unitId: plan.unitId, objects: plan.objects,
    });
    return plan.settled;
  }
  return runTwoPhaseVerifiedDelete({
    permit,
    root,
    unitId: plan.unitId,
    operation: plan.operation,
    ...(plan.runId === undefined ? {} : { runId: plan.runId }),
    key: key.key,
    keyEpochId: key.keyEpochId,
    actor: attested.actor,
    at: attested.at,
    objects: plan.objects,
    ...(attested.faults === undefined ? {} : { faults: attested.faults as DeleteFaultsForTest }),
  });
}

/** The three phases, once the driver has established it owns this operation. */
/**
 * One operation's driver input, marked as running under NO gate authorization.
 *
 * The three ungated callers — per-run quarantine, purge and key reset — reach
 * this driver by their own entry points rather than through a destructive
 * acquisition, so there is no ticket to re-evaluate. They say so in the type
 * rather than omitting a field, which is what keeps a future GATED caller from
 * inheriting the exemption by silence.
 */
export type UngatedInput<T> = T & { readonly authorization: "ungated" };

/** Mark one request as running under no gate authorization. */
export function ungated<T extends object>(input: T): UngatedInput<T> {
  return { ...input, authorization: "ungated" as const };
}

/**
 * Raised when the gate's decision no longer holds against the executor's own
 * capture — the authorization described a state that has since changed.
 *
 * A DISTINCT CLASS so a caller can tell "the project moved under me" from every
 * other reason a destructive operation declines. It subsumes the sweep-only
 * `SweepTargetDivergedError`, whose comparison was a strict subset of this one.
 */
export class LifecycleAuthorizationDivergedError extends Error {
  constructor(message: string) {
    super(`destructive authorization no longer holds: ${message}`);
    this.name = "LifecycleAuthorizationDivergedError";
  }
}

/**
 * Re-run the GATE'S OWN predicate over this capture, or refuse.
 *
 * NOT AN EQUIVALENT CHECK — the same function. The test that matters is whether
 * this could be written without knowing which fields the gate looked at: it
 * could not, because it does not look at fields at all. It rebuilds the pending
 * state from this snapshot through the same pure projector the gate consumed,
 * hands it to {@link evaluateDestructiveAuthorization}, and requires the verdict
 * to be the one that was authorized. Every refusal the gate would raise —
 * unavailable, reset custody, an unobservable registry, an incomplete
 * observation, an unowned unit — arrives for free, because it is that function
 * raising it.
 *
 * A DIVERGED VERDICT REFUSES rather than retargets: acting on the gate's value
 * would delete bytes this capture cannot see, and acting on this capture's value
 * would delete bytes nothing approved.
 */
function reauthorizeAgainstCapture(
  authorization: LifecycleAuthorizationV1 | "ungated",
  read: PreparationLifecycleReadV1,
): void {
  if (authorization === "ungated") return;
  if (read.status === "unavailable") {
    throw new LifecycleAuthorizationDivergedError(
      `the lifecycle state could not be read when the ${authorization.intent} was about to act: ${read.detail}`,
    );
  }
  const current = evaluateDestructiveAuthorization(
    authorization.intent, authorization.targetUnitId, projectLifecyclePending(read.snapshot),
  );
  if (current?.unitId !== authorization.ticket?.unitId
    || current?.operation !== authorization.ticket?.operation) {
    throw new LifecycleAuthorizationDivergedError(
      `the ${authorization.intent} was authorized for ${describeTicket(authorization.ticket)} `
      + `but this capture resolves ${describeTicket(current)}`,
    );
  }
}

/** Name a ticket for a refusal message, without leaking a path. */
function describeTicket(ticket: LifecycleGateTicketV1 | null): string {
  return ticket === null ? "a fresh start" : `${ticket.operation} unit ${ticket.unitId}`;
}

async function driveCustodyOperation<
  TInput extends LifecycleCustodyRequest, K extends LifecyclePlanKind,
>(
  root: string,
  adapter: LifecycleCustodyAdapter<TInput, K>,
  input: TInput,
): Promise<LifecycleReceiptOfKind<K>> {
  // EXACTLY ONE capture INSIDE THIS DRIVER, for every operation, with no way to
  // opt out. The previous shape let an adapter declare `consumesCapture: false`
  // and assess from its own independent reads, which is the deferred variant
  // this migration exists to replace rather than defer again. Whatever an
  // adapter needs that the snapshot carries, it takes from here.
  //
  // THAT CLAIM USED TO BE WRITTEN WITHOUT ITS SCOPE, AND THE MISSING SCOPE WAS
  // THE DEFECT. It is true within this function and false across the
  // gate -> driver boundary: the gate takes its own capture to authorize, this
  // one takes another to act, and a lifecycle state that appeared in between was
  // consulted by neither. Reproduced end to end — a sweep authorized against a
  // partial view deleted an orphan's manifest and evidence while a signed
  // quarantine unit sat pending. The comment read as a guarantee that the race
  // could not happen, which is what steered readers away from the seam.
  //
  // So the gate's decision is RE-EVALUATED here, against this capture, by
  // calling the gate's own predicate rather than a local equivalent.
  const assessment = await withPreparationLifecycleRead(root, (read) => {
    reauthorizeAgainstCapture(input.authorization, read);
    return adapter.assess(root, input, read);
  });
  // SEALED, not merely described as sealed. `readonly` is type-level only, and
  // `materialize` receives the whole assessment — so without this a future
  // adapter that "just needs to add one object to the scope" would edit the plan
  // after the capture that justified it had closed, and the signed receipt would
  // attest a set nothing observed. Demonstrated in review: objects wiped and
  // residual obligations replaced, with the receipt following.
  const plan = sealCustodyPlan(assessment.draft);
  // `input` here IS the sealed copy taken before the first await, so these are
  // already immune to caller mutation. Kept as a named binding because the
  // receipt's identity fields deserve to be visibly separate from the plan's.
  const attested = { actor: input.actor, at: input.at, faults: input.faults };
  // F4: `planKind` was WRITE-ONLY -- five declarations, zero reads -- so the
  // engine was chosen by adapter-produced DATA one phase later, not by the
  // adapter's declaration, and the docblock's "selected here" was false. The
  // compile-time binding also only holds for ANNOTATED adapters: an inline one
  // widens `K` to the whole union and can cross its declaration with its draft.
  // This makes the declaration load-bearing and turns the receipt cast below from
  // asserted into checked.
  if (plan.kind !== adapter.planKind) {
    throw new Error(
      `adapter declared planKind ${adapter.planKind} and planned ${plan.kind}`);
  }
  const permit = mintLifecycleMutationPermit(adapter.operation, plan.unitId);
  const key = await adapter.materialize(root, input, assessment, permit);
  // The cast is the one place the plan/receipt correlation is asserted rather
  // than inferred: `runPlanEngine` returns the union, and TypeScript cannot see
  // that `plan.kind` and `K` are the same discriminant through the adapter. Every
  // OTHER site -- adapter, assessment, complete -- is checked, so a wrong pairing
  // is caught there rather than here.
  const receipt = await runPlanEngine(root, plan, key, permit, attested) as LifecycleReceiptOfKind<K>;
  // AFTER the receipt is durable, still inside the driver, still under the same
  // permit. Anything here runs only because the operation genuinely completed.
  await adapter.complete?.(root, input, receipt, permit);
  return receipt;
}

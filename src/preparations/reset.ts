/**
 * @file src/preparations/reset.ts
 * @description Missing/unreadable-key project reset (design sections 25.3, 25.4).
 * A missing or unreadable preparation key makes every run untrustworthy, so no
 * ordinary transition can proceed; the operator explicitly quarantines ALL active
 * preparation authority across workspaces and mints one fresh epoch. The reset is
 * DELIBERATELY two-invocation, and the two passes are bound by an OPERATOR-CARRIED
 * one-time continuation secret: pass one verifies the real key state, records only
 * the digest of that secret in an unsigned intent marker, and returns the secret to
 * the caller. Every file in the reset unit is attacker-influenceable, so a planted
 * intent or key can never drive a completion on its own — pass two runs only when the
 * caller presents the matching secret, and the staged fresh key is authenticated by
 * that secret. The fresh key material is persisted (create-only) before it is
 * published active so a crash stays recoverable, and it is removed once the reset
 * completes durably. A forced reset moves the unreadable key leaf into quarantine
 * before minting, or it fails closed; nothing here touches Milestone A or live pages.
 */

import { ungated, type UngatedInput } from "./lifecycle-driver.js";
import { randomBytes } from "node:crypto";
import { readPreparationKey } from "./key-epoch.js";
import { preparationKeyEpochId } from "./run-integrity.js";
import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import { enumerateProjectScope } from "./quarantine.js";
import {
  moveOldPreparationKey,
  publishActivePreparationKey,
  readResetUnitLeaf,
  removeResetCrashLeaves,
  resetIntentLeafPresence,
  writeResetUnitLeaf,
} from "./lifecycle-fs/reset-operations.js";
import {
  listQuarantineUnits, readSettledQuarantineReceipt, retirableUnitsFrom, type RetirementSet,
  type QuarantineMoveFaultsForTest,
} from "./quarantine-move.js";
import {
  buildResetIntent, matchesContinuationDigest, parseResetIntent, requiredResetConfirmation,
  parsePendingResetKey, resetContinuationDigest, signPendingResetKey,
  verifyPendingResetKey,
  type QuarantineReceiptV1, type ResetIntentV1,
} from "./receipts.js";
import { supersedeIntentOnlyUnitsLocked } from "./reset-intent-supersession.js";
import {
  completeLifecycleCustodyOperation, runLifecycleCustodyOperation, type LifecycleCustodyAdapter,
} from "./lifecycle-driver.js";
import type { LifecycleMutationPermitV1 } from "./lifecycle-mutation-permit.js";
import type { PreparationLifecycleReadV1 } from "./lifecycle-snapshot/read.js";
import { projectQuarantineUnits } from "./lifecycle-snapshot/compat.js";
import type { QuarantineReason, RetiredQuarantineUnitV1 } from "./receipts.js";
import { mintPreparationRunId } from "./ids.js";
import type { PreparationPrincipalV1 } from "./run-types.js";
import type { Sha256Digest } from "./types.js";

const PREPARATION_KEY_BYTES = 32;

/** The freshly minted reset key and its epoch id, in memory. */
interface ResetKeyMaterial { key: Buffer; keyEpochId: Sha256Digest }

/** The distinct confirmation flag each reset reason demands (design section 25.3). */
// Re-exported, not redefined: the parser owns the reason/confirmation pairing so a
// reader cannot disagree with it about what a marker means.
export { FORCED_KEY_CONFIRMATION, MISSING_KEY_CONFIRMATION } from "./receipts.js";

type ResetReason = ResetIntentV1["reason"];

/** Deterministic crash seams for the reset-specific durable boundaries. */
export interface ResetFaultsForTest extends QuarantineMoveFaultsForTest {
  afterOldKeyMoved?: () => Promise<void>;
  afterPendingKeyStaged?: () => Promise<void>;
  afterKeyMint?: () => Promise<void>;
}

/** Explicit destructive confirmation for one project key-epoch reset. */
export interface ResetKeyEpochInput {
  actor: PreparationPrincipalV1;
  at: string;
  confirmation: string;
  continuation?: { unitId: string; token: string };
  supersedePendingReset?: boolean;
  faults?: ResetFaultsForTest;
}

/** The two-invocation reset outcome: the recorded intent, or the completed reset. */
export type ResetKeyEpochResult =
  | { status: "intent-recorded"; unitId: string; reason: ResetReason; continuationToken: string }
  | { status: "completed"; unitId: string; keyEpochId: Sha256Digest; receipt: QuarantineReceiptV1 }
  | { status: "pending-intent-superseded"; unitIds: readonly string[] };

type CompletedReset = Extract<ResetKeyEpochResult, { status: "completed" }>;

/** Typed fail-closed refusal naming why a reset could not proceed. */
export class PreparationResetError extends Error {
  constructor(
    readonly code: "key-healthy" | "confirmation-mismatch" | "continuation-mismatch" | "continuation-unreadable" | "pending-key-unreadable" | "pending-key-invalid" | "reset-already-pending" | "old-key-immovable",
    message: string,
  ) {
    super(message);
    this.name = "PreparationResetError";
  }
}

/** The confirmation string a given reset reason requires. */


/**
 * Reset the preparation key epoch. Pass two runs ONLY when the caller presents the
 * one-time continuation secret from pass one (bound to a durable digest no planted
 * file can forge); otherwise this records a fresh first-pass intent and returns a new
 * secret. A healthy key is refused: there is nothing to reset.
 */
export async function resetPreparationKeyEpochLocked(root: string, input: ResetKeyEpochInput): Promise<ResetKeyEpochResult> {
  // BEFORE the continuation read. The driver seals what reaches it, but this
  // entry awaits `openContinuation` first, so everything between here and the
  // driver was a mutation window: review changed `actor.id` immediately after
  // calling this and the completed receipt was signed as the changed actor.
  const captured = captureResetInput(input);
  if (captured.continuation === undefined) return recordResetIntent(root, captured);
  const { unitId, reason, secret } = await openContinuation(root, captured.continuation);
  return executeReset(root, unitId, reason, secret, captured);
}

/**
 * Copy every authority-bearing field, by value, before the first await.
 *
 * `continuation` is nested authority — it names the unit and carries the secret
 * that authorizes pass two — so a top-level copy would leave it aliased exactly
 * as `binding` was on the quarantine side.
 *
 * Data only. `faults` is a test seam of functions, carried by reference; it names
 * no authority and appears in no receipt.
 */
function captureResetInput(input: ResetKeyEpochInput): ResetKeyEpochInput {
  return Object.freeze({
    actor: Object.freeze({ id: input.actor.id, surface: input.actor.surface }),
    at: input.at,
    confirmation: input.confirmation,
    ...(input.continuation === undefined ? {} : {
      continuation: Object.freeze({
        unitId: input.continuation.unitId,
        token: input.continuation.token,
      }),
    }),
    ...(input.supersedePendingReset === undefined ? {} : { supersedePendingReset: input.supersedePendingReset }),
    ...(input.faults === undefined ? {} : { faults: input.faults }),
  });
}

/** Decode a continuation token into its exact 32-byte secret, or refuse. */
function decodeContinuationSecret(token: string): Buffer {
  const secret = Buffer.from(token, "base64");
  if (secret.length !== PREPARATION_KEY_BYTES || secret.toString("base64") !== token) {
    throw new PreparationResetError("continuation-mismatch", "reset continuation token is malformed");
  }
  return secret;
}

/**
 * Open the ONE reset the operator named, proving the secret authorizes that exact
 * unit. The unit is addressed directly rather than searched: scanning for the first
 * unit whose digest matches would let a copy of a legitimate intent in another unit
 * capture the same token. The intent must also self-bind to the directory it was read
 * from, so a marker copied under a different unit id is refused.
 */
async function openContinuation(root: string, continuation: { unitId: string; token: string }): Promise<{ unitId: string; reason: ResetReason; secret: Buffer }> {
  const secret = decodeContinuationSecret(continuation.token);
  const read = await readResetUnitLeaf(root, continuation.unitId, "intent");
  // THREE-way, for the same reason `completedReceiptDigest` is. Collapsing
  // `unavailable` into `absent` here told the operator "no pending intent" about
  // a marker that IS there and merely cannot be read — a false statement, and
  // the one that makes this state undiagnosable: pass two says the intent is
  // absent while pass one refuses because `resetIntentLeafPresence` correctly
  // sees it present. The two legs disagreed about the same file because only one
  // of them kept the distinction.
  if (read.status === "unavailable") {
    throw new PreparationResetError(
      "continuation-unreadable",
      `the reset intent for unit ${continuation.unitId} exists but cannot be read; repair or remove that unit's reset-intent.json`,
    );
  }
  if (read.status !== "ok") {
    throw new PreparationResetError("continuation-mismatch", "the named reset unit has no pending intent");
  }
  const intent = parseResetIntent(read.body.toString("utf8"));
  if (intent.unitId !== continuation.unitId || !matchesContinuationDigest(secret, intent.continuationDigest)) {
    throw new PreparationResetError("continuation-mismatch", "the continuation token does not authorize the named reset unit");
  }
  return { unitId: continuation.unitId, reason: intent.reason, secret };
}

/**
 * First pass: validate the real key state, then record the intent and mint a secret.
 * A second pending intent is refused rather than silently created: two live intents
 * would leave whichever one is not completed permanently pending. An operator who no
 * longer holds a pending unit's token supersedes it explicitly, which is safe because
 * a pending intent can only exist while no fresh key has been published.
 */
async function recordResetIntent(root: string, input: ResetKeyEpochInput): Promise<ResetKeyEpochResult> {
  // Supersession runs BEFORE eligibility: a healthy key makes a NEW reset ineligible,
  // so checking it first left a stale intent-only unit permanently blocking lifecycle
  // work with no supported exit. Clearing a pre-plan marker authorises nothing.
  const superseded = input.supersedePendingReset === true
    ? await supersedeIntentOnlyUnitsLocked(root, input.confirmation, requiredResetConfirmation)
    : [];
  const key = await readPreparationKey(root);
  if (key.status === "ok") {
    if (superseded.length > 0) return { status: "pending-intent-superseded", unitIds: superseded };
    throw new PreparationResetError("key-healthy", "reset requires a missing or unreadable preparation key");
  }
  const reason: ResetReason = key.status === "absent" ? "missing-key" : "unreadable-key-forced";
  if (input.confirmation !== requiredResetConfirmation(reason)) {
    throw new PreparationResetError("confirmation-mismatch", `reset of a ${reason} key requires its distinct confirmation`);
  }
  await settlePendingIntents(root, input.supersedePendingReset === true, superseded);
  const secret = randomBytes(PREPARATION_KEY_BYTES);
  const unitId = `rst-${mintPreparationRunId().slice("prr_".length)}`;
  const intent = buildResetIntent({
    unitId, reason, confirmation: input.confirmation,
    continuationDigest: resetContinuationDigest(secret), actor: input.actor, at: input.at,
  });
  await writeResetUnitLeaf(root, unitId, "intent", canonicalBytes(intent));
  return { status: "intent-recorded", unitId, reason, continuationToken: secret.toString("base64") };
}

/**
 * Refuse to open a second reset while any intent remains. This NEVER deletes: the
 * narrow supersession pass above has already cleared every unit that was provably
 * intent-only, so anything still here is either continuation-materialized or
 * unclassifiable — exactly the state whose crash material must stay recoverable.
 */
async function settlePendingIntents(root: string, _supersede: boolean, alreadySuperseded: readonly string[]): Promise<void> {
  const listing = await listQuarantineUnits(root);
  if (listing.status !== "ok") {
    throw new PreparationResetError("reset-already-pending",
      "the quarantine registry is unreadable; a concurrent pending reset cannot be ruled out");
  }
  for (const unitId of listing.unitIds) {
    if (alreadySuperseded.includes(unitId)) continue; // cleared above by the explicit exit
    const intent = await resetIntentLeafPresence(root, unitId);
    if (intent === "unavailable") {
      throw new PreparationResetError("reset-already-pending",
        `reset unit ${unitId} is unreadable; a pending reset there cannot be ruled out`);
    }
    if (intent === "absent") continue;
    throw new PreparationResetError("reset-already-pending",
      `reset unit ${unitId} still holds continuation state; continue it with its token`);
  }
}

/** Second pass: resolve the fresh key, quarantine authority, then remove crash material. */
async function executeReset(root: string, unitId: string, reason: ResetReason, secret: Buffer, input: ResetKeyEpochInput): Promise<ResetKeyEpochResult> {
  if (input.confirmation !== requiredResetConfirmation(reason)) {
    throw new PreparationResetError("confirmation-mismatch", `reset rerun of a ${reason} key requires its distinct confirmation`);
  }
  const adapter = projectResetAdapter(unitId, reason, secret);
  const done = await readCompletedReset(root, unitId, reason);
  if (done !== null) {
    // Already durable, so there is no sequence left to run — but the cleanup is
    // still a permitted mutation, and the driver still mints for it.
    await completeLifecycleCustodyOperation(root, adapter, ungated(input), done.receipt, unitId);
    return done;
  }
  // Crash-material removal is now the driver's `complete` phase, under the same
  // permit, rather than something this function does afterwards.
  const receipt = await runLifecycleCustodyOperation(root, adapter, ungated(input));
  return { status: "completed", unitId, keyEpochId: receipt.keyEpochId as Sha256Digest, receipt };
}

/**
 * Project reset as a driver adapter (PLA-INV-07). The epoch MINT stays in the
 * authorize leg rather than becoming a driver phase: it is reset-specific
 * pre-custody work with no quarantine analogue, and design V1 §10.1 gives adapters
 * operation-specific eligibility. The driver owns only the custody protocol that
 * follows it.
 *
 * The unit id, reason, and continuation secret are closed over rather than passed
 * through the request, because they are already proved by `openContinuation` and
 * must not be re-derivable from adapter input.
 */
function projectResetAdapter(
  unitId: string, reason: ResetReason, secret: Buffer,
): LifecycleCustodyAdapter<UngatedInput<ResetKeyEpochInput>> {
  return {
    operation: "reset",
    planKind: "custody-move",

    // READ-ONLY. Reads the active and staged keys, decides whether an epoch must
    // be materialized, and builds the plan draft from the one driver-owned
    // capture. The retirement set takes its unit ids from that capture rather
    // than re-enumerating the registry.
    async assess(root, _input, read) {
      const resolved = await assessResetKey(root, unitId, secret);
      const retirement = await retirableUnitsFromRead(root, read, unitId);
      return {
        ...(resolved === null ? {} : { key: resolved }),
        draft: {
          kind: "custody-move" as const,
          unitId, scope: "project-reset", reason,
          objects: await enumerateProjectScope(root, read),
          residualObligations: residualObligationsFor(reason, retirement.unreadable),
          retiredUnits: retirement.retired,
        },
      };
    },

    // MUTATES, under the permit. Old-key custody, staging, and publication are
    // each permit-protected mutations in their own right (design V2 §9.2), not
    // eligibility work — which is why they cannot sit in `assess`.
    // The completion phase the driver owns. Removing crash material used to
    // happen in `executeReset` after the driver returned, with no permit.
    async complete(root, _input, _receipt, permit) {
      await removeResetCrashLeaves(root, unitId, permit);
    },

    async materialize(root, input, assessment, permit) {
      if (assessment.key !== undefined) return assessment.key;
      return materializeResetKey(root, unitId, reason, secret, input, permit);
    },
  };
}

/**
 * Every obligation this reset carries out, including any unit it could not attest.
 *
 * A unit whose completed receipt is unreadable is named here rather than being
 * dropped or refused, so the operator can see exactly what was left unfinished
 * and the reset itself still completes.
 */
function residualObligationsFor(
  reason: QuarantineReason, unreadable: readonly string[],
): string[] {
  return [
    `preparation-key-${reason}`,
    "operator-accepted-all-residual-state",
    ...unreadable.map((unitId) => `quarantine-unit-${unitId}-completed-receipt-unreadable`),
  ];
}

/**
 * The retirement set, taken from the driver's capture rather than a second
 * enumeration of the quarantine registry.
 */
async function retirableUnitsFromRead(
  root: string, read: PreparationLifecycleReadV1, excludeUnitId: string,
): Promise<RetirementSet> {
  // Distinct from the projection refusal below. Review found three legs sharing
  // one message, which let a test that had lost its subject keep matching.
  if (read.status !== "ok") throw new Error("quarantine registry read failed; refusing to attest a retirement set");
  // Projected through the SAME hardened primitive the deleted enumerator used.
  // Filtering `snapshot.units` directly would drop the second availability gate
  // `projectQuarantineUnits` applies — a quarantine problem carrying no unitId,
  // or an unavailable unit entry — either of which means the listing is a SUBSET
  // and attesting a retirement set from it would under-retire silently.
  const listing = projectQuarantineUnits(read.snapshot);
  if (listing.status !== "ok") throw new Error("quarantine registry listing is incomplete; refusing to attest a retirement set");
  return retirableUnitsFrom(root, listing.unitIds, excludeUnitId);
}

/**
 * The read-only half of the old `resolveResetKey`. Returns the governing key when
 * one already exists and needs no materialization, or null when the epoch must
 * still be minted. Refuses a healthy key that is not this unit's staged epoch,
 * exactly as before — that refusal is what stops a planted or restored key
 * driving a reset over live authority.
 */
async function assessResetKey(
  root: string, unitId: string, secret: Buffer,
): Promise<ResetKeyMaterial | null> {
  const active = await readPreparationKey(root);
  if (active.status !== "ok") return null;
  // Post-publication, `unreadable` and `absent` deliberately behave the SAME —
  // both refuse as a healthy foreign key. That equivalence is PLA-MAP-R12's
  // dated, accepted known gap, and review confirmed the two refusals are
  // byte-identical, so this leg is left exactly as decided.
  const pending = await readAuthenticatedPendingKey(root, unitId, secret);
  if (pending.kind !== "ok" || !active.key.equals(pending.material.key)) {
    throw new PreparationResetError(
      "key-healthy",
      "reset rerun found a healthy preparation key that is not this unit's staged reset epoch; refusing to quarantine live authority",
    );
  }
  return { key: active.key, keyEpochId: active.keyEpochId };
}

/**
 * The mutating half of the old `resolveResetKey`, now permit-bound. Ordering is
 * unchanged and load-bearing: old-key custody first so a forced reset never mints
 * over an unquarantined key, then staging create-only, then publication.
 */
async function materializeResetKey(
  root: string, unitId: string, reason: ResetReason, secret: Buffer,
  input: ResetKeyEpochInput, permit: LifecycleMutationPermitV1,
): Promise<ResetKeyMaterial> {
  if (reason === "unreadable-key-forced") {
    await moveOldKeyIntoUnit(root, unitId, permit);
    await input.faults?.afterOldKeyMoved?.();
  }
  const pending = await readAuthenticatedPendingKey(root, unitId, secret);
  // An unreadable staged key cannot be resumed AND cannot be replaced:
  // `stagePendingResetKey` writes create-only, so falling through to it collides
  // with the very file we could not read. Review measured that: the collision
  // surfaced as an untyped "atomic no-replace destination already exists", and
  // every remaining route refused with advice to continue using the token — the
  // one action that provably throws.
  //
  // An earlier comment here claimed re-minting "supersedes it rather than racing
  // it". That was false; create-only means it cannot. So this refuses in its own
  // words and names the file to repair, symmetric with `continuation-unreadable`
  // one leg up. Making the write replace-instead-of-create would weaken a
  // create-only invariant to fix an ergonomics problem, which is the wrong trade.
  if (pending.kind === "unreadable") {
    throw new PreparationResetError(
      "pending-key-unreadable",
      `the staged reset key for unit ${unitId} exists but cannot be read; repair or remove that unit's pending-reset-key.json`,
    );
  }
  // A DIFFERENT code, not a different sentence under one code. Both kinds share a
  // disposition — the file is there, staging is create-only, so neither may fall
  // through — but they are different facts with different operator responses, and
  // `code` is the public union a consumer switches on. Telling a caller a file
  // "cannot be read" when it reads fine and fails to AUTHENTICATE is the same
  // merge-of-two-facts this function was already fixed for once, re-collapsed one
  // layer out at the error code. The authenticate case is the attacker-relevant
  // one, which is exactly the one that must not hide behind the other's name.
  if (pending.kind === "invalid") {
    throw new PreparationResetError(
      "pending-key-invalid",
      `the staged reset key for unit ${unitId} does not authenticate; remove that unit's pending-reset-key.json to restage`,
    );
  }
  const material = pending.kind === "ok"
    ? pending.material
    : await stagePendingResetKey(root, unitId, secret, permit);
  await input.faults?.afterPendingKeyStaged?.();
  await publishActiveResetKey(root, unitId, material, permit);
  await input.faults?.afterKeyMint?.();
  return material;
}



/**
 * Stage the fresh reset key material create-only under the unit BEFORE it is ever
 * published active, authenticated by the continuation secret. Persisting the bytes
 * makes the reset crash-resumable; the HMAC binding means only a holder of the secret
 * can stage a key this unit will accept.
 */
async function stagePendingResetKey(root: string, unitId: string, secret: Buffer, permit: LifecycleMutationPermitV1): Promise<ResetKeyMaterial> {
  const key = randomBytes(PREPARATION_KEY_BYTES);
  const keyEpochId = preparationKeyEpochId(key);
  const record = signPendingResetKey(secret, { unitId, keyEpochId, key: key.toString("base64") });
  await writeResetUnitLeaf(root, unitId, "pending-key", canonicalBytes(record), permit);
  return { key, keyEpochId };
}

/**
 * Publish the staged reset key to the active slot create-only (the single-epoch
 * guard). A collision is tolerated ONLY when the already-installed active key is this
 * exact staged key (an idempotent resume or a concurrent reset of the same unit);
 * any other installed key is a genuine single-epoch race.
 */
async function publishActiveResetKey(root: string, unitId: string, material: ResetKeyMaterial, permit: LifecycleMutationPermitV1): Promise<void> {
  const result = await publishActivePreparationKey(root, material.key.toString("base64"), unitId, permit);
  if (result === "created") return;
  const active = await readPreparationKey(root);
  if (active.status === "ok" && active.key.equals(material.key)) return;
  throw new Error("preparation reset key already exists (single-epoch race)");
}

/**
 * Read this unit's staged key, verified under the secret.
 *
 * FOUR-way, and the fourth term is load-bearing. The domain has four states —
 * valid, present-but-invalid, unreadable, and genuinely not there — and an
 * earlier version had three, folding "present but invalid" into `absent`.
 *
 * That folding matters because of what `absent` licenses: it is the ONLY branch
 * whose caller may fall through to a create-only write. So the invariant this
 * type exists to protect is precise —
 *
 *   only a leaf that is PROVABLY NOT THERE may be treated as absent.
 *
 * A malformed body, a failed HMAC, or a wrong key length all describe a file
 * that IS on disk, and staging over it collides. The bad-HMAC path is the
 * attacker-relevant one: everything in a reset unit is attacker-influenceable,
 * so garbage written over the staged key must not brick the reset.
 */
type PendingKeyRead =
  | { readonly kind: "ok"; readonly material: ResetKeyMaterial }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "unreadable" };

async function readAuthenticatedPendingKey(root: string, unitId: string, secret: Buffer): Promise<PendingKeyRead> {
  const read = await readResetUnitLeaf(root, unitId, "pending-key");
  if (read.status === "unavailable") return { kind: "unreadable" };
  if (read.status !== "ok") return { kind: "absent" };
  try {
    // Every failure below this point describes a file that IS present, so none
    // of them may report `absent`.
    const record = parsePendingResetKey(read.body.toString("utf8"));
    if (!verifyPendingResetKey(secret, unitId, record)) return { kind: "invalid" };
    const key = Buffer.from(record.key, "base64");
    const keyEpochId = preparationKeyEpochId(key);
    if (key.length !== PREPARATION_KEY_BYTES || record.keyEpochId !== keyEpochId) return { kind: "invalid" };
    return { kind: "ok", material: { key, keyEpochId } };
  } catch {
    return { kind: "invalid" };
  }
}

/**
 * Return this unit's completed reset ONLY on proof of full semantic settlement: the
 * completed kind, project-reset scope, this unit, this reason, and the epoch the
 * active key actually holds. A merely present or planned-but-signed receipt is not a
 * completion and must never short-circuit the destructive work.
 */
async function readCompletedReset(root: string, unitId: string, reason: ResetReason): Promise<CompletedReset | null> {
  const active = await readPreparationKey(root);
  if (active.status !== "ok") return null;
  const receipt = await readSettledQuarantineReceipt(root, unitId, active.key, {
    keyEpochId: active.keyEpochId, scope: "project-reset", reason,
  });
  if (receipt === null) return null;
  return { status: "completed", unitId, keyEpochId: active.keyEpochId, receipt };
}

/**
 * Remove this unit's crash material once the reset has settled durably (design
 * section 25.4): the plaintext staged key first, then the reset-intent marker whose
 * absence is what marks the unit no longer pending. Each delete reconfines the leaf at
 * delete time and fsyncs its parent, so a power loss cannot resurrect the plaintext
 * key after the API reported success, and a swapped parent cannot redirect the unlink.
 */
/**
 * Move the unreadable key leaf into the unit byte-for-byte, or fail before minting.
 * Only a PROVED absence means a prior crashed attempt already moved it; a leaf we
 * merely cannot stat must never be skipped, or the reset would mint a fresh epoch
 * while the old key material stayed in place unquarantined.
 */
async function moveOldKeyIntoUnit(root: string, unitId: string, permit: LifecycleMutationPermitV1): Promise<void> {
  try {
    await moveOldPreparationKey(root, unitId, permit);
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes("cannot be examined")) {
      throw new PreparationResetError(
        "old-key-immovable",
        "the old key leaf cannot be examined; refusing to mint over it",
      );
    }
    if (message.includes("not a movable regular file")) {
      throw new PreparationResetError(
        "old-key-immovable",
        "the unreadable key leaf is not a movable regular file",
      );
    }
    throw new PreparationResetError("old-key-immovable", "the unreadable key leaf could not be moved into quarantine");
  }
}

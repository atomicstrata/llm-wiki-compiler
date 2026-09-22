/**
 * @file src/preparations/quarantine-move.ts
 * @description The crash-safe two-phase byte-preserving quarantine engine (design
 * section 25.4). It NEVER interprets, rewrites, or destroys the original bytes: it
 * plans a signed inventory, RENAMES each scoped leaf into the unit's `bytes/`
 * directory, fsyncs, verifies the moved inventory by path, byte count, and digest
 * where cheaply readable, and only then writes the signed completed receipt. The
 * planned receipt is the durable crash marker: an interrupted move resumes
 * idempotently against that same signed plan (a leaf already at its destination is
 * treated as moved, never re-moved or lost), and a completed receipt short-circuits
 * to a no-op. A quarantined-then-restored run must never become trusted, so the
 * engine only moves bytes and signs receipts; it never re-signs run history.
 */

import {
  assertLifecycleMutationPermit, type LifecycleMutationPermitV1,
} from "./lifecycle-mutation-permit.js";
import { createHash } from "node:crypto";
import { lstat, mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { atomicWriteNoReplaceDurable } from "../utils/atomic-write.js";
import { fsyncDirectoryChain } from "../utils/atomic-write-durability.js";
import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import { readCappedNoFollowBuffer } from "../utils/confined-read.js";
import { lstatLeaf } from "../utils/fs-presence.js";
import { moveVerifiedLeaf, verifyPlannedBytes } from "../utils/planned-bytes.js";
import { MAX_PREPARATION_EVIDENCE_OBJECT_BYTES } from "./constants.js";
import { preparationQuarantineUnitPaths } from "./paths.js";
import {
  listQuarantineUnitsFromRoot,
  quarantineUnitPendingFromRoot,
} from "./lifecycle-snapshot/compat.js";
import {
  parseLifecycleReceipt, signQuarantineReceipt, verifyLifecycleReceipt,
  MAX_LIFECYCLE_RECEIPT_BYTES, type QuarantineObjectV1, type QuarantineReason,
  type QuarantineReceiptContentV1, type QuarantineReceiptV1, type QuarantineScope,
  type RetiredQuarantineUnitV1,
} from "./receipts.js";
import type { PreparationPrincipalV1 } from "./run-types.js";

/** Lifecycle hashing streams, so the ceiling is the real evidence-object bound. */
const VERIFY_HASH_CAP_BYTES = MAX_PREPARATION_EVIDENCE_OBJECT_BYTES;

/** One scoped leaf to move: absolute source, `.llmwiki`-relative logical id, size. */
export interface ScopedQuarantineObject {
  sourcePath: string;
  logicalPath: string;
  byteCount: number;
  digest: string | null;
}

/** Deterministic crash seams placed immediately after each durable boundary. */
export interface QuarantineMoveFaultsForTest {
  afterPlanned?: () => Promise<void>;
  afterMoves?: () => Promise<void>;
  beforeCompleted?: () => Promise<void>;
}

/** Complete governing input for one two-phase quarantine unit. */
export interface QuarantineMoveInput {
  /** Driver-minted proof that authorization and planning already succeeded. */
  permit?: LifecycleMutationPermitV1;
  root: string;
  unitId: string;
  scope: QuarantineScope;
  reason: QuarantineReason;
  runId?: string;
  key: Buffer;
  keyEpochId: string;
  actor: PreparationPrincipalV1;
  at: string;
  objects: readonly ScopedQuarantineObject[];
  residualObligations: readonly string[];
  /** Superseded-epoch units this receipt attests as retired (project reset only). */
  retiredUnits?: readonly RetiredQuarantineUnitV1[];
  faults?: QuarantineMoveFaultsForTest;
}

/**
 * Read a bounded receipt leaf and verify it under the governing key, or null. A valid
 * HMAC alone is NOT enough: the receipt must also bind the exact kind and unit it is
 * being read as. Both receipt kinds are signed by the same key, so without that
 * binding a signed `quarantine-planned` leaf copied over the completed filename would
 * be honoured as proof of completion before any byte moved.
 */
async function readVerifiedReceipt(
  file: string, key: Buffer, kind: QuarantineReceiptContentV1["kind"], unitId: string,
): Promise<QuarantineReceiptV1 | null> {
  const read = await readCappedNoFollowBuffer(file, MAX_LIFECYCLE_RECEIPT_BYTES);
  if (read.kind === "absent") return null;
  if (read.kind !== "ok") throw new Error("quarantine receipt is unreadable");
  const receipt = parseLifecycleReceipt(read.body.toString("utf8")) as QuarantineReceiptV1;
  if (!verifyLifecycleReceipt(key, receipt)) throw new Error("quarantine receipt failed verification");
  if (receipt.kind !== kind || receipt.unitId !== unitId) throw new Error("quarantine receipt does not bind this unit and kind");
  return receipt;
}

/**
 * Return one unit's completed receipt ONLY when it proves full semantic settlement:
 * authenticated by the governing key, of the completed kind, bound to this unit, and
 * matching the expected epoch, scope, and reason. Any weaker signal — a present file,
 * a valid signature over a planned receipt, a receipt from a superseded epoch — is
 * NOT settlement and returns null. This is the single primitive every settlement
 * question routes through, so a check can never read a completion the executor would
 * not have written.
 */
export async function readSettledQuarantineReceipt(
  root: string, unitId: string, key: Buffer,
  expect: { keyEpochId: string; scope?: QuarantineScope; reason?: QuarantineReason },
): Promise<QuarantineReceiptV1 | null> {
  const paths = preparationQuarantineUnitPaths(root, unitId);
  try {
    const receipt = await readVerifiedReceipt(paths.completedReceiptFile, key, "quarantine-completed", unitId);
    if (receipt === null || receipt.keyEpochId !== expect.keyEpochId) return null;
    if (expect.scope !== undefined && receipt.scope !== expect.scope) return null;
    if (expect.reason !== undefined && receipt.reason !== expect.reason) return null;
    return receipt;
  } catch {
    return null;
  }
}

/** Assign each scoped object a stable portable destination name in sorted order. */
function planObjects(objects: readonly ScopedQuarantineObject[]): QuarantineObjectV1[] {
  return [...objects]
    .sort((left, right) => left.logicalPath.localeCompare(right.logicalPath))
    .map((object, index) => ({
      logicalPath: object.logicalPath, objectName: `obj-${String(index).padStart(6, "0")}`,
      byteCount: object.byteCount, digest: object.digest,
    }));
}

/**
 * The exact inventory one unit committed to at plan time: the leaves to move and, for
 * a project reset, the superseded units it retires. Both are signed into the planned
 * receipt and REUSED verbatim on resume, so a completion can never attest an inventory
 * the plan did not authorise.
 */
type QuarantineAuthority = Omit<QuarantineReceiptContentV1, "kind">;

interface QuarantinePlan {
  authority: QuarantineAuthority;
}

/** Build the signed content for one planned or completed quarantine receipt. */
function receiptContent(
  kind: QuarantineReceiptContentV1["kind"], authority: QuarantineAuthority,
): QuarantineReceiptContentV1 {
  return { ...authority, kind };
}

/** Capture the immutable authority shared by a planned/completed receipt pair. */
function quarantineAuthority(
  input: QuarantineMoveInput, objects: readonly QuarantineObjectV1[],
): QuarantineAuthority {
  return {
    schemaVersion: 1, scope: input.scope, reason: input.reason, unitId: input.unitId,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    keyEpochId: input.keyEpochId, objects, residualObligations: [...input.residualObligations],
    ...(input.retiredUnits === undefined ? {} : { retiredUnits: [...input.retiredUnits] }),
    actor: { id: input.actor.id, surface: input.actor.surface }, at: input.at,
  };
}

/** Durably publish one signed receipt leaf create-only, fsynced with its parent. */
async function writeReceipt(root: string, file: string, receipt: QuarantineReceiptV1): Promise<void> {
  await atomicWriteNoReplaceDurable(file, canonicalBytes(receipt), { confineRoot: root, exactParent: true, mode: 0o600 });
}

/**
 * Phase one: reuse the signed plan on resume, else create/fsync the planned receipt.
 * A resume returns the plan's OWN authenticated inventory — objects and retirement
 * attestation alike — never a fresh enumeration, so state that changed since the plan
 * was signed cannot drift into the completion.
 */
async function planPhase(input: QuarantineMoveInput): Promise<QuarantinePlan> {
  const paths = preparationQuarantineUnitPaths(input.root, input.unitId);
  const existing = await readVerifiedReceipt(paths.plannedReceiptFile, input.key, "quarantine-planned", input.unitId);
  if (existing !== null) {
    const { kind: _kind, integrity: _integrity, ...authority } = existing;
    return { authority };
  }
  await mkdir(paths.bytesRoot, { recursive: true });
  const plan: QuarantinePlan = {
    authority: quarantineAuthority(input, planObjects(input.objects)),
  };
  await writeReceipt(input.root, paths.plannedReceiptFile,
    signQuarantineReceipt(input.key, receiptContent("quarantine-planned", plan.authority)));
  return plan;
}

/**
 * Move one planned leaf. A destination that merely EXISTS is not proof the move
 * happened: the move is applied only when the source is provably absent AND the
 * destination holds exactly the planned bytes. Both present is a conflict — a copy of
 * the planned bytes beside a still-live source would otherwise let the unit complete
 * while the run it was supposed to remove stayed in active authority.
 */
async function moveObject(root: string, unitId: string, object: QuarantineObjectV1): Promise<void> {
  const paths = preparationQuarantineUnitPaths(root, unitId);
  const dest = paths.byteObjectFile(object.objectName);
  const destLeaf = await lstatLeaf(dest);
  const sourcePath = path.join(root, ".llmwiki", object.logicalPath);
  const sourceLeaf = await lstatLeaf(sourcePath);
  if (destLeaf.kind === "unavailable" || sourceLeaf.kind === "unavailable") {
    throw new Error(`quarantine leaf cannot be examined: ${object.logicalPath}`);
  }
  if (destLeaf.kind === "present") {
    if (sourceLeaf.kind === "present") {
      // The create-only commit links before it unlinks, so both names can briefly
      // hold the SAME object. That is a half-finished commit to be completed, not a
      // conflict; two DIFFERENT objects at the two names is the real conflict.
      if (destLeaf.stats.dev !== sourceLeaf.stats.dev || destLeaf.stats.ino !== sourceLeaf.stats.ino) {
        throw new Error(`quarantine source and destination both present: ${object.logicalPath}`);
      }
      await unlink(sourcePath);
      // Completing a half-finished commit removes a source entry, which must be as
      // durable as the commit that created the destination.
      await fsyncDirectoryChain(path.dirname(sourcePath));
    }
    await assertMovedBytes(root, paths.bytesRoot, dest, object);
    return;
  }
  const destPresent = destLeaf.kind;
  const sourcePresent = sourceLeaf.kind;
  if (sourcePresent === "absent") throw new Error(`quarantine source and destination both absent: ${object.logicalPath}`);
  await moveVerifiedSource(root, sourcePath, dest, object);
}

/** Prove an already-moved destination holds exactly the bytes the plan enumerated. */
async function assertMovedBytes(root: string, bytesRoot: string, dest: string, object: QuarantineObjectV1): Promise<void> {
  const verified = await verifyPlannedBytes({
    root, file: dest, expectedDir: bytesRoot, plan: object,
    label: "quarantine destination", maxBytes: VERIFY_HASH_CAP_BYTES,
  });
  if (verified === "absent") throw new Error(`quarantine destination vanished mid-observation: ${object.logicalPath}`);
}

/** Prove the source is the planned object and move it as one verified operation. */
async function moveVerifiedSource(root: string, source: string, dest: string, object: QuarantineObjectV1): Promise<void> {
  const leaf = await lstatLeaf(source);
  if (leaf.kind !== "present") throw new Error(`quarantine source vanished before the move: ${object.logicalPath}`);
  if (!leaf.stats.isFile() || leaf.stats.isSymbolicLink()) throw new Error("quarantine source is not a regular file");
  const moved = await moveVerifiedLeaf({
    root, file: source, expectedDir: path.dirname(source), dest, destDir: path.dirname(dest), plan: object,
    label: "quarantine source", maxBytes: VERIFY_HASH_CAP_BYTES,
  });
  if (moved === "absent") throw new Error(`quarantine source vanished before the move: ${object.logicalPath}`);
}

/**
 * Phase two: move every planned leaf byte-for-byte, then fsync the bytes tree. A
 * resumed unit re-proves each source against the signed plan first; a fresh plan
 * enumerated its digests moments earlier under the same lock.
 */
async function movePhase(input: QuarantineMoveInput, objects: readonly QuarantineObjectV1[]): Promise<void> {
  const paths = preparationQuarantineUnitPaths(input.root, input.unitId);
  for (const object of objects) await moveObject(input.root, input.unitId, object);
  await fsyncDirectoryChain(paths.bytesRoot);
}

/** Phase three: verify each moved leaf by byte count and cheap-readable digest. */
async function verifyPhase(root: string, unitId: string, objects: readonly QuarantineObjectV1[]): Promise<void> {
  for (const object of objects) {
    const dest = preparationQuarantineUnitPaths(root, unitId).byteObjectFile(object.objectName);
    const destStat = await stat(dest).catch(() => null);
    if (destStat === null || !destStat.isFile() || destStat.size !== object.byteCount) {
      throw new Error(`quarantine verification failed for ${object.logicalPath}`);
    }
    await assertMovedBytes(root, preparationQuarantineUnitPaths(root, unitId).bytesRoot, dest, object);
  }
}

/**
 * Run (or idempotently resume) the two-phase quarantine of one scoped unit. A
 * completed receipt short-circuits; otherwise the signed plan drives the move,
 * verification, and the signed completed receipt. The governing key signs and
 * authenticates every receipt.
 */
export async function runTwoPhaseQuarantine(input: QuarantineMoveInput): Promise<QuarantineReceiptV1> {
  assertLifecycleMutationPermit(input.permit, input.unitId);
  const paths = preparationQuarantineUnitPaths(input.root, input.unitId);
  const completed = await readVerifiedReceipt(paths.completedReceiptFile, input.key, "quarantine-completed", input.unitId);
  if (completed !== null) return completed;
  const plan = await planPhase(input);
  await input.faults?.afterPlanned?.();
  await movePhase(input, plan.authority.objects);
  await input.faults?.afterMoves?.();
  await verifyPhase(input.root, input.unitId, plan.authority.objects);
  await input.faults?.beforeCompleted?.();
  const receipt = signQuarantineReceipt(input.key,
    receiptContent("quarantine-completed", plan.authority));
  await writeReceipt(input.root, paths.completedReceiptFile, receipt);
  return receipt;
}

/** Digest one unit's completed receipt exactly as it sits on disk, or null if unreadable. */
async function completedReceiptDigest(
  root: string, unitId: string,
): Promise<{ kind: "digest"; digest: string } | { kind: "absent" } | { kind: "unavailable" }> {
  const file = preparationQuarantineUnitPaths(root, unitId).completedReceiptFile;
  const read = await readCappedNoFollowBuffer(file, MAX_LIFECYCLE_RECEIPT_BYTES);
  // THREE-way, deliberately. Collapsing `unavailable` into `absent` here made an
  // unreadable receipt - oversize, non-regular, symlinked, EACCES - look exactly
  // like a unit that was never completed, so it was silently dropped from the
  // attestation and then stranded: its plan no longer authenticates under the
  // fresh key, it was never retired, and the one operation that could have
  // retired it has already finished.
  if (read.kind === "absent") return { kind: "absent" };
  if (read.kind !== "ok") return { kind: "unavailable" };
  return { kind: "digest", digest: createHash("sha256").update(read.body).digest("hex") };
}


/**
 * What one pass over the unit list could and could not attest.
 *
 * `unreadable` is NOT a refusal. An earlier revision threw here, and review
 * proved that turns one damaged file into a project-wide deadlock: a single
 * unreadable `quarantine-completed.json` on ANY unit permanently blocked the key
 * reset, purge cannot clear it (purge needs the healthy key whose absence is the
 * reason the reset exists), and superseding just mints a fresh unit that hits the
 * same refusal — demonstrated non-terminating over three full cycles.
 *
 * That is precisely what `enumerateProjectScope` already warns against in this
 * package: refusing "would dead-end the very operation that exists to recover
 * from a lost key". So the unit is named as a residual obligation instead.
 *
 * WHAT THAT DOES AND DOES NOT DO, stated exactly, because the surrounding code
 * has already had to correct three comments claiming one level more than they
 * delivered. `residualObligations` is ATTESTATION ONLY: it is signed into the
 * receipt and shape-validated, and nothing in this codebase consumes it. So the
 * unit is NOT retired and NOT recovered. Its plan still does not authenticate
 * under the fresh key, and it stays exactly where the silent drop left it.
 *
 * What changed is the project, not the unit: the reset COMPLETES, so the
 * operator is no longer locked out of the recovery operation itself. This is the
 * "explicit escape" tier — visible and non-blocking — not "take custody".
 * Retiring such a unit needs evidence that cannot exist while the key is absent,
 * which is the same wall the stranded-reset rescue designs hit.
 */
export interface RetirementSet {
  readonly retired: readonly RetiredQuarantineUnitV1[];
  /** Units whose completed receipt could not be read, named so they are visible. */
  readonly unreadable: readonly string[];
}

/**
 * The retirement set over an ALREADY-ENUMERATED unit list.
 *
 * The driver captures the registry once and supplies those ids, so a reset no
 * longer enumerates it a second time inside the same decision. The per-unit
 * receipt reads remain: a lifecycle snapshot carries unit shapes, not receipt
 * bytes, and the digest attested here has to come from the bytes themselves.
 */
export async function retirableUnitsFrom(
  root: string, unitIds: readonly string[], excludeUnitId: string,
): Promise<RetirementSet> {
  const retired: RetiredQuarantineUnitV1[] = [];
  const unreadable: string[] = [];
  for (const unitId of unitIds) {
    if (unitId === excludeUnitId) continue;
    const receipt = await completedReceiptDigest(root, unitId);
    if (receipt.kind === "unavailable") unreadable.push(unitId);
    if (receipt.kind === "digest") retired.push({ unitId, receiptDigest: receipt.digest });
  }
  return {
    retired: retired.sort((left, right) => left.unitId.localeCompare(right.unitId)),
    unreadable: unreadable.sort(),
  };
}

/**
 * Whether this unit has an AUTHENTICATED plan under the active key — the only proof
 * that we ourselves started this destructive operation and may resume it. This is
 * distinct from {@link quarantineUnitPending}: pending answers the detective question
 * "is something unfinished here" and errs toward flagging, while started answers the
 * authorization question "may we skip the fresh-start precondition" and so must rest
 * on positive evidence. Using the detective answer here would let anyone who creates a
 * unit directory waive the precondition and quarantine a healthy run.
 */
export async function quarantineUnitStarted(root: string, unitId: string, key: Buffer): Promise<boolean> {
  const paths = preparationQuarantineUnitPaths(root, unitId);
  try {
    return (await readVerifiedReceipt(paths.plannedReceiptFile, key, "quarantine-planned", unitId)) !== null;
  } catch {
    return false;
  }
}

/**
 * Whether a quarantine unit holds an UNFINISHED destructive operation in the active
 * epoch. Finished history from a superseded epoch is not pending.
 */
export async function quarantineUnitPending(root: string, unitId: string): Promise<boolean> {
  return quarantineUnitPendingFromRoot(root, unitId);
}

/** List every quarantine-unit directory id currently present under the root. */
export async function listQuarantineUnits(
  root: string,
): Promise<{ status: "ok"; unitIds: readonly string[] } | { status: "unavailable" }> {
  return listQuarantineUnitsFromRoot(root);
}

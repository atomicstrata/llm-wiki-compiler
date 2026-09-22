/**
 * @file src/preparations/quarantine.ts
 * @description Per-run quarantine of an integrity-invalid preparation under a
 * healthy key, plus quarantine-unit enumeration and explicit purge (design
 * sections 25.2, 25.5). An integrity-invalid run cannot be transitioned or
 * re-signed, so its exclusively-owned manifest, evidence, run, and cancel bytes
 * are moved out of active authority through the crash-safe two-phase engine and
 * RETAINED until a second, explicitly confirmed purge. The precondition is a
 * fail-closed allowlist: a valid run (which belongs to abandonment) and a
 * missing/unreadable key (which belongs to reset) are both refused. The unit id is
 * derived deterministically from the run id so a re-run resumes the SAME unit
 * rather than opening a duplicate, and every entry point demands the explicit
 * destructive confirmation. Purge destroys only a complete, receipt-verified unit's
 * quarantined bytes and retains the signed receipts as the historical tombstone.
 */

import { ungated, type UngatedInput } from "./lifecycle-driver.js";
import { createHash } from "node:crypto";
import { readPreparationKey } from "./key-epoch.js";
import {
  runLifecycleCustodyOperation,
  type LifecycleCustodyAdapter, type LifecycleGoverningKey,
} from "./lifecycle-driver.js";
import {
  captureLifecycleScopedObject,
  enumeratePruneCustodyLeaves,
  quarantineCompletedReceiptStatus,
  quarantineUnitConfinement,
} from "./lifecycle-fs/quarantine-operations.js";
import { PreparationLifecycleNamespaceError } from "./lifecycle-fs/namespace.js";
import { readPreparationRun } from "./run-store.js";
import { scanActivePreparationStore, type PreparationLeafObservation } from "./orphan-scan.js";
import type { PreparationLifecycleReadV1 } from "./lifecycle-snapshot/types.js";
import { type QuarantineReceiptV1 } from "./receipts.js";
import {
  quarantineUnitStarted, readSettledQuarantineReceipt, type QuarantineMoveFaultsForTest,
  type ScopedQuarantineObject,
} from "./quarantine-move.js";
import type { PreparationPrincipalV1, PreparationRunBinding } from "./run-types.js";

/** Typed fail-closed refusal naming why a quarantine or purge could not proceed. */
export class PreparationQuarantineError extends Error {
  constructor(
    readonly code: "confirmation-required" | "key-missing" | "key-unreadable" | "not-integrity-invalid"
      | "unit-incomplete" | "unit-unavailable",
    message: string,
  ) {
    super(message);
    this.name = "PreparationQuarantineError";
  }
}

/** Explicit residual-state confirmation for one per-run quarantine. */
export interface QuarantineRunInput {
  binding: PreparationRunBinding;
  actor: PreparationPrincipalV1;
  at: string;
  confirmResidualState: boolean;
  faults?: QuarantineMoveFaultsForTest;
}

/** Derive the stable per-run quarantine-unit id so a re-run resumes one unit. */
export function perRunQuarantineUnitId(runId: string): string {
  return `qtn-${createHash("sha256").update(runId, "utf8").digest("hex").slice(0, 32)}`;
}

/** Build one scoped move object from an observed preparation leaf. */
async function scopedObject(root: string, leaf: PreparationLeafObservation): Promise<ScopedQuarantineObject> {
  return scopedLeafObject(root, leaf.relativePath, leaf.bytes);
}

/** Build one scoped move object from a source path and observed byte count. */
export async function scopedLeafObject(root: string, relativePath: string, byteCount: number): Promise<ScopedQuarantineObject> {
  try {
    return await captureLifecycleScopedObject(root, relativePath, byteCount);
  } catch (error) {
    throw new PreparationQuarantineError("unit-unavailable", (error as Error).message);
  }
}

/**
 * Scan the preparation store for a DESTRUCTIVE plan, refusing an inventory that is not
 * authoritative. A scan reports problems when a directory could not be listed, the
 * depth bound was hit, or the entry bound was exhausted — in every such case the leaf
 * set is a SUBSET of what exists. Planning from a subset would quarantine less than
 * the scope claims while signing a receipt that attests the whole scope, so the plan
 * is refused until the inventory can be taken completely.
 */
export async function scanForDestructivePlan(root: string, read: PreparationLifecycleReadV1) {
  // REGISTRY completeness comes from the driver's capture, not from walking the
  // registry again. The previous version called `scanPreparationOrphans`, which
  // walks active storage AND the lifecycle registry — a second enumeration of
  // state the capture had just observed, and the inconsistent-observation window
  // this migration exists to close. Both callers then filtered every quarantine
  // leaf back out, so the second walk fed nothing but its own problem list.
  if (read.status !== "ok") {
    throw new PreparationQuarantineError("unit-unavailable",
      "the lifecycle capture is unavailable; refusing to plan a destructive scope");
  }
  // ONLY the problems that mean the registry LISTING is a subset. That is what
  // the walk this replaces actually detected, and it is the property a
  // destructive plan depends on: planning from a partial listing quarantines a
  // subset and reports success.
  //
  // Deliberately NOT gated on per-unit content problems — `receipt-bytes-exhausted`
  // and friends. Those describe one unit's contents, not the completeness of the
  // listing, and refusing on them would rebuild the exact deadlock the
  // unreadable-receipt fix had to remove: one damaged file in one unit blocking
  // every destructive operation on the project. Measured: gating on all problems
  // turned 18 tests red, most of them the recovery paths that fix restored.
  // Scoped to the QUARANTINE registry, which is exactly what the replaced walk
  // covered. Prune-registry problems keep their own downstream refusal, which
  // names the prune registry and the reason — gating on them here pre-empted that
  // with a generic message and lost the diagnosis.
  const blocking = read.snapshot.problems
    .filter((problem) => problem.registry === "quarantine")
    .map((problem) => problem.code)
    .filter((code) => REGISTRY_COMPLETENESS_PROBLEMS.has(code));
  if (blocking.length > 0) {
    const codes = [...new Set(blocking)].sort().join(", ");
    throw new PreparationQuarantineError("unit-unavailable",
      `preparation inventory is incomplete (${codes}); refusing to plan a destructive scope from a partial scan`);
  }
  // ACTIVE storage still needs its own walk: a lifecycle snapshot carries unit
  // and storage state, never the per-leaf detail a plan must name. This is the
  // narrowly bound read, not a second look at the registry.
  return completeActiveScan(root);
}

/**
 * Snapshot problems that mean the registry listing itself is incomplete, so any
 * plan derived from it would silently cover a subset.
 */
const REGISTRY_COMPLETENESS_PROBLEMS: ReadonlySet<string> = new Set([
  "registry-unavailable", "registry-entries-exhausted", "unit-entry-unavailable",
]);

/**
 * The active-storage walk plus its completeness gate.
 *
 * A destructive plan may only be built from a COMPLETE inventory: planning from
 * a partial scan quarantines a subset and reports success.
 */
async function completeActiveScan(root: string) {
  const scan = await scanActivePreparationStore(root);
  if (scan.problems.length > 0) {
    const dimensions = [...new Set(scan.problems.map((problem) => problem.dimension))].sort().join(", ");
    throw new PreparationQuarantineError("unit-unavailable",
      `preparation inventory is incomplete (${dimensions}); refusing to plan a destructive scope from a partial scan`);
  }
  return scan;
}

/** Enumerate the leaves a per-run quarantine exclusively owns (never shared bytes). */
export async function enumerateRunScope(
  root: string, binding: PreparationRunBinding, read: PreparationLifecycleReadV1,
): Promise<ScopedQuarantineObject[]> {
  return ownedRunLeaves(root, binding, await scanForDestructivePlan(root, read));
}

/** The leaves one run exclusively owns, from an already-gated scan. */
function ownedRunLeaves(
  root: string, binding: PreparationRunBinding, scan: { leaves: readonly PreparationLeafObservation[] },
): Promise<ScopedQuarantineObject[]> {
  const owned = scan.leaves.filter((leaf) => leaf.kind !== "quarantine" && leaf.workspaceId === binding.workspaceId
    && (leaf.preparationId === binding.preparationId || leaf.runId === binding.runId));
  return Promise.all(owned.map((leaf) => scopedObject(root, leaf)));
}

/**
 * Enumerate every active preparation leaf across workspaces for a project reset,
 * INCLUDING bytes staged mid-delete inside prune units. Those bytes are authenticated
 * under the epoch the reset is destroying, and a sweep cannot finish them without the
 * key that is being replaced — so leaving them behind would strand them permanently
 * unverifiable. The reset takes custody of them instead of refusing, which would
 * dead-end the very operation that exists to recover from a lost key.
 */
export async function enumerateProjectScope(
  root: string, read: PreparationLifecycleReadV1,
): Promise<ScopedQuarantineObject[]> {
  const scan = await scanForDestructivePlan(root, read);
  const active = scan.leaves.filter((leaf) => leaf.kind !== "quarantine");
  const staged = await enumeratePruneUnitContents(root);
  return [...await Promise.all(active.map((leaf) => scopedObject(root, leaf))), ...staged];
}

/**
 * Collect EVERY durable leaf under the prune registry, receipts included. Taking only
 * the staged bytes would leave receipts authenticated by the epoch this reset is
 * destroying: the next sweep reads one, cannot verify it under the fresh key, and
 * fails permanently. The reset therefore empties each unit completely.
 */
async function enumeratePruneUnitContents(root: string): Promise<ScopedQuarantineObject[]> {
  try {
    const leaves = await enumeratePruneCustodyLeaves(root);
    return Promise.all(leaves.map((leaf) =>
      scopedLeafObject(root, leaf.relativePath, leaf.byteCount)));
  } catch (error) {
    if (error instanceof PreparationQuarantineError) throw error;
    throw new PreparationQuarantineError("unit-unavailable", (error as Error).message);
  }
}

/**
 * Quarantine one integrity-invalid run under the healthy current key. Fails closed
 * unless the run is exactly integrity-invalid and the key is healthy; a re-run
 * resumes the same deterministic unit idempotently. The confirmation is always
 * required, so a resume repeats the same explicit destructive confirmation.
 */
export async function quarantinePreparationRunLocked(root: string, input: QuarantineRunInput): Promise<QuarantineReceiptV1> {
  return runLifecycleCustodyOperation(root, perRunQuarantineAdapter, captureQuarantineInput(input));
}

/**
 * Copy every authority-bearing field, by value, before the first await.
 *
 * The driver seals what it knows about — actor and timestamp — but `binding` is
 * this operation's own authority and a top-level copy left it ALIASED: review
 * mutated `binding.runId` during the assessment and the signed receipt carried
 * the mutated id. Field by field is the only version that holds, because a
 * shallow copy protects the fields it names and nothing beneath them.
 *
 * Data only. `faults` is a test seam of functions and is carried by reference
 * deliberately; it names no authority and appears in no receipt.
 */
function captureQuarantineInput(input: QuarantineRunInput): UngatedInput<QuarantineRunInput> {
  return Object.freeze({
    authorization: "ungated" as const,
    binding: Object.freeze({
      runId: input.binding.runId,
      preparationId: input.binding.preparationId,
      manifestDigest: input.binding.manifestDigest,
      workspaceId: input.binding.workspaceId,
      keyEpochId: input.binding.keyEpochId,
    }),
    actor: Object.freeze({ id: input.actor.id, surface: input.actor.surface }),
    at: input.at,
    confirmResidualState: input.confirmResidualState,
    ...(input.faults === undefined ? {} : { faults: input.faults }),
  });
}

/**
 * Per-run quarantine as a driver adapter (PLA-INV-07). It supplies only
 * eligibility and the object set; the custody protocol itself belongs to the
 * driver. Every refusal code and its message are unchanged, because they are part
 * of this operation's contract and the driver does not reinterpret them.
 */
const perRunQuarantineAdapter: LifecycleCustodyAdapter<UngatedInput<QuarantineRunInput>> = {
  operation: "quarantine",
  planKind: "custody-move",

  // Read-only throughout. Per-run quarantine has no epoch to materialize, so the
  // key it reads here is the key the custody phase uses.
  async assess(root, input, read) {
    if (input.confirmResidualState !== true) {
      throw new PreparationQuarantineError("confirmation-required", "quarantine requires explicit residual-state confirmation");
    }
    // ELIGIBILITY comes from the driver's capture, which already carries the key
    // STATE. Deciding it from an independent read was the observation this
    // migration exists to remove, and it also let the decision and the material
    // disagree — the snapshot could say absent while a key appeared a moment
    // later, and only the second read would be believed.
    if (read.status !== "ok") {
      throw new PreparationQuarantineError("key-unreadable", "per-run quarantine requires a healthy key; use reset");
    }
    const keyState = read.snapshot.keyState;
    if (keyState.status === "absent") throw new PreparationQuarantineError("key-missing", "per-run quarantine requires a healthy key; use reset");
    if (keyState.status !== "ok") throw new PreparationQuarantineError("key-unreadable", "per-run quarantine requires a healthy key; use reset");
    // The BYTES still need their own read, and this is the honest limit of the
    // single capture: a lifecycle snapshot carries key state and epoch id, never
    // key material, because HMAC verification and the custody phase both need
    // the secret itself. The capture decides eligibility; this supplies material,
    // and the epoch ids are cross-checked so the two cannot silently diverge.
    const key = await readPreparationKey(root);
    if (key.status !== "ok" || key.keyEpochId !== keyState.keyEpochId) {
      throw new PreparationQuarantineError("key-unreadable", "per-run quarantine requires a healthy key; use reset");
    }
    const unitId = perRunQuarantineUnitId(input.binding.runId);
    // The fresh-start precondition is part of assessment, not authorization: a
    // unit already started waives it only on proof of semantic settlement.
    if (!(await quarantineUnitStarted(root, unitId, key.key))) {
      await assertIntegrityInvalid(root, input.binding, unitId, { key: key.key, keyEpochId: key.keyEpochId });
    }
    return {
      key: { key: key.key, keyEpochId: key.keyEpochId },
      draft: {
          kind: "custody-move" as const,
        unitId, scope: "per-run", reason: "run-integrity-invalid", runId: input.binding.runId,
        objects: await enumerateRunScope(root, input.binding, read),
        residualObligations: ["run-integrity-invalid", "operator-accepted-residual-state"],
      },
    };
  },

  // Nothing to materialize. The permit is still minted and carried, because the
  // custody engine requires one however the key was obtained.
  materialize: (_root, _input, assessment) => {
    if (assessment.key === undefined) throw new Error("per-run quarantine assessed without a governing key");
    return Promise.resolve(assessment.key);
  },
};

/**
 * Enforce the fresh-start precondition: the run reads exactly integrity-invalid. A
 * prior quarantine waives it only on proof of SEMANTIC settlement — a merely present
 * completed file (a signed planned receipt copied over that name) must never waive
 * the precondition and let a healthy run be quarantined.
 */
async function assertIntegrityInvalid(
  root: string, binding: PreparationRunBinding, unitId: string, key: { key: Buffer; keyEpochId: string },
): Promise<void> {
  const settled = await readSettledQuarantineReceipt(root, unitId, key.key, {
    keyEpochId: key.keyEpochId, scope: "per-run", reason: "run-integrity-invalid",
  });
  if (settled !== null) return; // already quarantined; the engine settles idempotently
  const read = await readPreparationRun(root, binding);
  if (!(read.status === "unavailable" && read.code === "run-integrity-invalid")) {
    throw new PreparationQuarantineError("not-integrity-invalid",
      `per-run quarantine requires an integrity-invalid run, saw ${read.status === "ok" ? read.run.state : read.status}`);
  }
}

/** Explicit destroy confirmation for one complete quarantine unit's bytes. */
export interface PurgeQuarantineInput {
  unitId: string;
  actor: PreparationPrincipalV1;
  at: string;
  confirmDestroy: boolean;
}

/**
 * Purge one complete quarantine unit's bytes after verifying its completed receipt
 * under the current key. It deletes only the moved bytes and keeps the signed
 * receipts as the minimal historical tombstone; a pending or unverifiable unit is
 * refused. It never touches live state or the record that a reset/abandonment
 * occurred.
 */
const purgeAdapter: LifecycleCustodyAdapter<UngatedInput<PurgeQuarantineInput>, "verified-destroy"> = {
  operation: "purge",
  planKind: "verified-destroy",

  async assess(root, input) {
    if (input.confirmDestroy !== true) {
      throw new PreparationQuarantineError("confirmation-required", "purge requires explicit destroy confirmation");
    }
    const key = await readPreparationKey(root);
    if (key.status !== "ok") throw new PreparationQuarantineError("unit-unavailable", "purge requires the current key to verify the unit");
    const { confinement, receiptStatus } = await observePurgeUnit(root, input.unitId);
    if (confinement === "redirected") {
      throw new PreparationQuarantineError("unit-unavailable", "quarantine unit is not a real confined directory");
    }
    if (receiptStatus === "absent") {
      throw new PreparationQuarantineError("unit-incomplete", "purge requires a completed quarantine unit");
    }
    const settled = await readSettledQuarantineReceipt(root, input.unitId, key.key, { keyEpochId: key.keyEpochId });
    if (settled === null) {
      throw new PreparationQuarantineError("unit-unavailable",
        "purge requires a completed receipt that authenticates for this exact unit, kind, and epoch");
    }
    return {
      draft: {
        kind: "verified-destroy" as const,
        unitId: input.unitId,
        objects: settled.objects,
        settled,
      },
      key: { key: key.key, keyEpochId: key.keyEpochId },
    };
  },

  materialize: async (_root, _input, assessment) => assessment.key as LifecycleGoverningKey,
};

/**
 * Purge one complete quarantine unit's bytes after verifying its completed receipt
 * under the current key. It deletes only the moved bytes and keeps the signed
 * receipts as the minimal historical tombstone; a pending or unverifiable unit is
 * refused. It never touches live state or the record that a reset/abandonment
 * occurred.
 */
export async function purgeQuarantineUnitLocked(root: string, input: PurgeQuarantineInput): Promise<void> {
  try {
    await runLifecycleCustodyOperation(root, purgeAdapter, ungated(input));
  } catch (error) {
    if (error instanceof PreparationQuarantineError) throw error;
    throw new PreparationQuarantineError("unit-unavailable", (error as Error).message);
  }
}

/** Observe purge prerequisites while preserving the adapter's typed refusal. */
async function observePurgeUnit(root: string, unitId: string) {
  try {
    return {
      confinement: await quarantineUnitConfinement(root, unitId),
      receiptStatus: await quarantineCompletedReceiptStatus(root, unitId),
    };
  } catch (error) {
    if (error instanceof PreparationLifecycleNamespaceError) {
      throw new PreparationQuarantineError("unit-unavailable", error.message);
    }
    throw error;
  }
}

/**
 * @file src/preparations/prune-delete.ts
 * @description The two-phase verified-delete engine, owned by the driver.
 *
 * This is the terminal engine for `verified-delete` plans, the sibling of
 * `runTwoPhaseQuarantine`. It lived in `retention.ts` as `runTwoPhaseDelete`,
 * where it was a SECOND complete plan/apply/verify/complete protocol driven by
 * the operation itself — which is what PLA-INV-07 forbids and Task 9E exists to
 * end.
 *
 * It is reached only from the driver's engine switch, never from an adapter, and
 * every mutation it performs carries the driver's permit. Before this, the prune
 * receipt writes and the leaf deletes took no permit at all: the most destructive
 * mutations in the package were reachable by any caller that imported them, so
 * "prune routes through the driver" would have moved the call sequence and
 * changed nothing about who may touch the bytes.
 */

import { createHash } from "node:crypto";
import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import {
  assertConfinedPruneUnit, deletePlannedPruneObject, readVerifiedPruneReceipt,
  writePruneReceiptBytes,
} from "./lifecycle-fs/prune-protocol.js";
import type { LifecycleMutationPermitV1 } from "./lifecycle-mutation-permit.js";
import type { ScopedQuarantineObject } from "./quarantine-move.js";
import { signPruneReceipt, type PruneReceiptContentV1, type PruneReceiptV1 } from "./receipts.js";
import type { PreparationPrincipalV1 } from "./run-types.js";

/** Deterministic crash seams placed at each durable prune/sweep boundary. */
export interface DeleteFaultsForTest {
  afterPlanned?: () => Promise<void>;
  afterStaged?: () => Promise<void>;
  afterDeletes?: () => Promise<void>;
  beforeCompleted?: () => Promise<void>;
}

/** Everything the engine needs, assembled field by field by the driver. */
export interface VerifiedDeleteEngineInput {
  readonly permit: LifecycleMutationPermitV1;
  readonly root: string;
  readonly unitId: string;
  readonly operation: PruneReceiptContentV1["operation"];
  readonly runId?: string;
  readonly key: Buffer;
  readonly keyEpochId: string;
  readonly actor: PreparationPrincipalV1;
  readonly at: string;
  readonly objects: readonly ScopedQuarantineObject[];
  readonly faults?: DeleteFaultsForTest;
}

type PruneAuthority = Omit<PruneReceiptContentV1, "kind">;

/** The unit id for one run's prune, derived from the run id alone. */
export function pruneUnitIdFor(runId: string): string {
  return `prn-${createHash("sha256").update(runId).digest("hex").slice(0, 32)}`;
}

/**
 * The unit id for one sweep, derived from the VISIBLE object paths.
 *
 * Load-bearing, not cosmetic: once the first object is staged it leaves the
 * inventory, so a later pass would derive a DIFFERENT id and strand the original
 * unit with staged bytes and no completed receipt, where nothing else enumerates
 * it. This is why an unfinished sweep must be resumed before a new one is derived.
 */
export function sweepUnitIdFor(objects: readonly ScopedQuarantineObject[]): string {
  const paths = objects.map((object) => object.logicalPath).sort().join("\0");
  return `swp-${createHash("sha256").update(paths).digest("hex").slice(0, 32)}`;
}

/** Build one signed prune/sweep receipt content minus its integrity field. */
function pruneReceiptContent(
  kind: PruneReceiptContentV1["kind"], authority: PruneAuthority,
): PruneReceiptContentV1 {
  return { ...authority, kind };
}

/** Capture the immutable authority shared by a planned/completed receipt pair. */
function pruneAuthority(
  input: VerifiedDeleteEngineInput,
  objects: readonly PruneReceiptContentV1["objects"][number][],
): PruneAuthority {
  return {
    schemaVersion: 1, operation: input.operation, unitId: input.unitId,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    keyEpochId: input.keyEpochId, objects,
    actor: { id: input.actor.id, surface: input.actor.surface }, at: input.at,
  };
}

/** Durably publish one signed prune receipt create-only with its parent fsync. */
async function writePruneReceipt(
  input: VerifiedDeleteEngineInput,
  kind: PruneReceiptContentV1["kind"],
  authority: PruneAuthority,
): Promise<void> {
  const receipt = signPruneReceipt(input.key, pruneReceiptContent(kind, authority));
  await writePruneReceiptBytes(
    input.permit, input.root, input.unitId, kind, canonicalBytes(receipt));
}

/** Phase one: reuse the signed plan on resume, else create/fsync the planned receipt. */
async function planDelete(
  input: VerifiedDeleteEngineInput,
): Promise<{ authority: PruneAuthority }> {
  const existing = await readVerifiedPruneReceipt(
    input.root, input.unitId, input.key, "prune-planned", input.operation);
  if (existing !== null) {
    const { kind: _kind, integrity: _integrity, ...authority } = existing;
    return { authority };
  }
  const objects = [...input.objects]
    .map((object) => ({
      logicalPath: object.logicalPath, byteCount: object.byteCount, digest: object.digest,
    }))
    .sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
  const authority = pruneAuthority(input, objects);
  await writePruneReceipt(input, "prune-planned", authority);
  return { authority };
}

/**
 * Delete only the exact planned leaves, idempotently, and fsync their parents.
 *
 * The index is the SIGNED plan's array position, and the staging slot name is
 * derived from it — so a resumed unit finds its staged bytes only because the
 * signed receipt's order is stable. Re-sorting or re-indexing here would make a
 * resume look in the wrong slot, see both ends absent, and complete with bytes
 * stranded: a false success, not a visible failure.
 */
async function deletePhase(
  input: VerifiedDeleteEngineInput,
  objects: readonly PruneReceiptContentV1["objects"][number][],
): Promise<void> {
  for (const [index, object] of objects.entries()) {
    await deletePlannedPruneObject(
      input.permit, input.root, input.unitId, index, object, input.faults?.afterStaged);
  }
}

/** Run (or idempotently resume) one planned/completed prune or sweep unit. */
export async function runTwoPhaseVerifiedDelete(
  input: VerifiedDeleteEngineInput,
): Promise<PruneReceiptV1> {
  await assertConfinedPruneUnit(input.root, input.unitId);
  const completed = await readVerifiedPruneReceipt(
    input.root, input.unitId, input.key, "prune-completed", input.operation);
  if (completed !== null) return completed;
  const plan = await planDelete(input);
  await input.faults?.afterPlanned?.();
  await deletePhase(input, plan.authority.objects);
  await input.faults?.afterDeletes?.();
  await input.faults?.beforeCompleted?.();
  const receipt = signPruneReceipt(
    input.key, pruneReceiptContent("prune-completed", plan.authority));
  await writePruneReceiptBytes(
    input.permit, input.root, input.unitId, "prune-completed", canonicalBytes(receipt));
  return receipt;
}

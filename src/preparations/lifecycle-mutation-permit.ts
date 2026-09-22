/**
 * @file src/preparations/lifecycle-mutation-permit.ts
 * @description The driver-owned mutation permit (design V2 §9.2).
 *
 * WHAT THIS IS: an accidental-bypass control inside trusted code. The custody
 * protocol and the three KEY-MATERIAL seams require a token only the driver
 * mints, and only after authorization and planning have already succeeded — so a
 * future caller cannot reach those paths without going through the driver by
 * accident.
 *
 * WHICH SEAMS, exactly, because an earlier version of this comment said "a
 * custody mutation" and meant less than that.
 *
 * GATED: the two-phase custody engine; the create / publish / move of the staged
 * key; and `removeResetCrashLeaves`, which destroys crash-resumption material
 * and now runs in the driver's completion phase under the same permit as the
 * operation that earned it. It used to run in the caller after the driver
 * returned, outside both the phase ordering and this contract — external review
 * caught that, and this list said "ungated" about it until the fix landed.
 *
 * ALSO GATED, from Task 9E: the verified-delete engine's two mutating seams —
 * `writePruneReceiptBytes` and `deletePlannedPruneObject`. Until 9E these took no
 * permit at all, so the prune and sweep byte deletes were reachable by any caller
 * that imported them. Routing prune through the driver without gating these would
 * have moved the call sequence and changed nothing about who may touch the bytes.
 *
 * ALSO GATED, from Task 9E chunk C2: `destroyQuarantineUnitBytes`, which
 * irreversibly unlinks the quarantined bytes and is the most destructive mutation
 * in the package. It is the ONE seam bound to a specific operation via
 * `expectedOperation: "purge"` — a quarantine or reset permit must not open it.
 * Until C2 this file said purge "never routes through the driver, so being ungated
 * is defensible"; that sentence is now false, and it has been replaced here rather
 * than left for someone to discover stale.
 *
 * NOT gated: the intent marker write (pass one precedes any operation to permit,
 * so requiring one would make pass one unreachable) and `clearResetIntentUnit`.
 *
 * WHAT THIS IS NOT, in the design's own words: "not an unforgeable security
 * boundary against modified JavaScript or the excluded same-UID adversary." The
 * brand is a module-private WeakSet. Anything running in this process can import
 * the minting seam and call it. That is deliberate — the control exists to stop
 * an honest mistake, not an attacker, and claiming more of it would be the kind
 * of overstatement this program has repeatedly had to correct.
 *
 * The minting seam is kept importable-but-watched rather than made structurally
 * unreachable: a static control asserts that only modules declared with the
 * `driver` role import it, which is the enforcement design V2 §9.1 item 5
 * specifies.
 */

/** Proof that the driver authorized and planned this mutation. */
export interface LifecycleMutationPermitV1 {
  readonly operation: "quarantine" | "reset" | "prune" | "sweep" | "purge";
  readonly unitId: string;
}

/**
 * Module-private brand. A permit is valid only if THIS module minted it, so a
 * structurally identical object literal assembled by a caller does not pass.
 */
const MINTED = new WeakSet<LifecycleMutationPermitV1>();

/**
 * Mint one permit. Callable only after the driver's authorize and plan phases
 * have succeeded — the driver is the only declared importer, and a static
 * control enforces that.
 */
export function mintLifecycleMutationPermit(
  operation: LifecycleMutationPermitV1["operation"],
  unitId: string,
): LifecycleMutationPermitV1 {
  const permit = Object.freeze({ operation, unitId });
  MINTED.add(permit);
  return permit;
}

/**
 * Refuse a mutation whose permit is absent, forged, or issued for another unit
 * — or, at a seam only one operation may reach, for another operation.
 *
 * The unit comparison catches a real mistake rather than a theoretical one: a
 * permit minted for one unit must not authorize a mutation against a different
 * unit, which is exactly what a mis-threaded refactor produces.
 *
 * `expectedOperation` is passed only where exactly one operation is legal. The
 * three reset key seams — create, publish and move of the staged key — are
 * reset-only; the shared custody engine deliberately
 * omits it, because both operations legitimately reach it and asserting there
 * would be a lie about who is allowed in. Review found the field authorizing
 * nothing at all — a permit carried an operation and no seam ever read it, so
 * a reset permit would have opened a quarantine-only mutation.
 */
export function assertLifecycleMutationPermit(
  permit: LifecycleMutationPermitV1 | undefined,
  unitId: string,
  expectedOperation?: LifecycleMutationPermitV1["operation"],
): void {
  if (permit === undefined || !MINTED.has(permit)) {
    throw new Error("lifecycle mutation requires a driver-minted permit");
  }
  if (permit.unitId !== unitId) {
    throw new Error("lifecycle mutation permit was issued for a different unit");
  }
  if (expectedOperation !== undefined && permit.operation !== expectedOperation) {
    throw new Error("lifecycle mutation permit was issued for a different operation");
  }
}

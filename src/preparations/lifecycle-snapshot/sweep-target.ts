/**
 * @file src/preparations/lifecycle-snapshot/sweep-target.ts
 * @description The ONE sweep-target selector, shared by the mutation gate that
 * authorizes a sweep and by the sweep executor that acts (design v10 §4 C3, v8
 * H2).
 *
 * WHY IT LIVES HERE RATHER THAN IN `retention.ts`. Sweep is the one destructive
 * operation whose target cannot be computed from its request: prune derives its
 * unit from the run binding the caller named, and the derivation is pure, so the
 * gate and the executor agree by construction. Sweep's target is an OBSERVATION
 * of the prune registry, and the selector was module-private to `retention.ts` —
 * so the gate had no way to reach it, and authorizing a sweep meant either
 * trusting a unit id the caller supplied or scanning a second time. Both are the
 * same defect: the check and the executor reading two different sources, with
 * the gate authorizing unit A while the executor deletes unit B's bytes.
 *
 * The seam is therefore a pure function of an already-captured unit set. It
 * performs no read of its own, so a caller cannot accidentally observe twice by
 * calling it, and there is exactly one place to change if the rule changes.
 *
 * BLOCKED IS NOT UNAVAILABLE AND NEITHER IS "NO TARGET". Three answers, because
 * three different things are true: `ok` with a `unitId` means an unfinished
 * sweep is there to resume, `ok` with `null` means the registry holds no
 * unfinished work of any kind so a fresh sweep may derive its own unit, and
 * `blocked` means somebody else's unfinished work occupies the registry. Reading
 * a blocked registry as "no target" would let a sweep start beside an unfinished
 * prune and derive a second unit over the same bytes.
 */

import type { LifecyclePendingUnitV1 } from "./compat.js";

/** The closed outcome of selecting the unit a sweep would act on. */
export type SweepTargetSelectionV1 =
  | { readonly status: "ok"; readonly unitId: string | null }
  | { readonly status: "blocked"; readonly unitId: string; readonly detail: string };

/**
 * Select the one prune-registry unit a sweep may resume, from an already
 * captured pending-unit set.
 *
 * SCOPED TO THE PRUNE REGISTRY, deliberately. A pending per-run quarantine or
 * key reset lives in the sibling registry and is not sweep's to resume — nor is
 * it this function's job to refuse it. Cross-registry ordering (a pending key
 * reset takes custody of the leaves every other destructive unit would touch) is
 * the gate's owner rule, which sees both registries; putting a second copy of it
 * here would be two rules that have to agree.
 *
 * @param units - Pending units from one capture (see `projectPendingUnits`).
 * @returns The unit to resume, the absence of one, or the unit that blocks.
 */
export function selectSweepTargetUnit(
  units: readonly LifecyclePendingUnitV1[],
): SweepTargetSelectionV1 {
  const inRegistry = units.filter((unit) => unit.registry === "prune");
  // EVERY non-sweep unit is checked, not just the first — and the honest reason
  // is robustness rather than a defect this fixes. Unit ids are prefixed
  // digests, so a blocking `prn-` unit sorts ahead of a `swp-` one in every
  // ordering a real scan produces, and examining only the first entry gives the
  // same answer today. What it does not give is an answer that survives a change
  // to the scan order — and the failure that change would cause is resuming a
  // sweep with another operation's bytes staged beneath it. The independence is
  // pinned directly, since no fixture can produce the ordering that separates
  // the two.
  const blocking = inRegistry.find((unit) => unit.operation !== "orphan-sweep");
  if (blocking !== undefined) {
    return {
      status: "blocked",
      unitId: blocking.unitId,
      // `null` reads as UNKNOWN rather than as a named operation: a unit whose
      // provenance could not be established is the one case nothing may resume.
      detail: `prune unit ${blocking.unitId} is an unfinished ${blocking.operation ?? "unknown"} operation; complete it before sweeping`,
    };
  }
  return { status: "ok", unitId: inRegistry[0]?.unitId ?? null };
}

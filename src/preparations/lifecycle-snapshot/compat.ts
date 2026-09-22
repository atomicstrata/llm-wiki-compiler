/**
 * @file src/preparations/lifecycle-snapshot/compat.ts
 * @description Pure legacy projections and the root-taking operation wrappers over the
 * root-bound lifecycle snapshot. Compatibility callers never rescan a registry
 * or inject key, receipt, path, or classifier authority.
 */

import { withPreparationLifecycleRead } from "./read.js";
import type {
  PreparationLifecycleOperationV1,
  PreparationLifecycleProblemV1,
  PreparationLifecycleSnapshotV1,
  PreparationLifecycleUnitV1,
} from "./types.js";

/** Legacy quarantine-directory listing shape retained through Task 9C. */
type QuarantineUnitListingV1 =
  | { status: "ok"; unitIds: readonly string[] }
  | { status: "unavailable" };

/**
 * Whether the prune registry may be TRUSTED, for the one consumer that asks.
 *
 * IT USED TO CARRY A PENDING UNIT LIST, and that list had no readers left once
 * the sweep target moved to the shared selector — a second enumeration of the
 * same units, kept alive by its own shape. Two enumerations of one fact is
 * precisely what §4 C3 exists to prevent, so the payload is gone and what
 * remains is the question this projection is actually asked: can the registry be
 * believed at all. Pendingness comes from `projectPendingUnits`, which is the
 * one home for it.
 */
type PruneRegistryHealthV1 =
  | { status: "ok" }
  | { status: "unavailable"; detail: string };

/**
 * One pending lifecycle unit, carrying the OPERATION that owns it (design v10
 * §4 C1).
 *
 * The operation is the whole point of this shape. The projection used to map
 * every pending unit to its `unitId` alone and hardcode a `quarantine-pending`
 * status, which is simply wrong for three of the four operations and left the
 * mutation gate unable to tell an owner from a sibling: a crashed sweep and a
 * crashed per-run quarantine were the same fact to every consumer. A unit whose
 * `operation` is `null` is UNKNOWN and owned by nobody — absent provenance is
 * not permission — so it is carried as `null` rather than guessed at.
 *
 * `registry` is carried because the two registries are enumerated independently
 * and a consumer's remedy differs by which one holds the unit.
 */
export interface LifecyclePendingUnitV1 {
  readonly registry: PreparationLifecycleUnitV1["registry"];
  readonly operation: PreparationLifecycleOperationV1 | null;
  readonly unitId: string;
}

/**
 * Joined lifecycle state retained by status and the mutation recovery gate.
 *
 * `unavailable` carries WHICH physical registries could not be trusted, because a
 * consumer's correct response differs by origin: a prune-only fault degrades to
 * prune-specific state by design, while an unobservable quarantine registry can
 * hide pending destructive work and must fail closed. Collapsing both into one
 * opaque `unavailable` forces every consumer to choose one answer for two
 * different facts, and the safe-looking choice fails OPEN on the quarantine case.
 *
 * An EMPTY `registries` means the origin could not be attributed at all — a
 * snapshot that is incomplete without naming a faulted registry. It is not
 * evidence of a confined fault, and a consumer that relaxes on prune-only must
 * treat it as unknown rather than benign.
 */
type LifecyclePendingStateV1 =
  | { status: "clean" }
  | {
    status: "pending";
    units: readonly LifecyclePendingUnitV1[];
    /**
     * Registries whose observation could not be trusted DESPITE the pending
     * work above, and the reason this arm exists in this shape.
     *
     * The two facts are not alternatives. Observed pending work and a faulted
     * registry co-occur — a crash mid-prune beside a quarantine registry that
     * has gone unreadable is one directory permission away — and the status can
     * only report one of them. Carrying the attribution HERE is what lets a
     * consumer act on both: a destructive operation must refuse on the fault
     * whether or not it also owns one of the units, and reading the pending arm
     * as proof the registries were readable is how a delete came to proceed
     * over a registry that could have been hiding the unit forbidding it.
     */
    unobservableRegistries: readonly PreparationLifecycleUnitV1["registry"][];
    /**
     * Whether the observation behind this arm was COMPLETE.
     *
     * The second half of the same evidence, and it is not subsumed by the
     * registry set. A registry-level fault attributes and lands in
     * `unobservableRegistries`; a UNIT-level one does not — an unreadable unit
     * directory leaves the registry itself readable, so nothing is attributed
     * while the snapshot is honestly incomplete. A consumer that must prove it
     * saw everything needs both signals; a consumer that only asks "is anything
     * unfinished" needs neither, which is why adding them obliges no existing
     * reader to change.
     *
     * `snapshotHasPendingLifecycle` in this same file already keeps this signal
     * for exactly that reason, and `projectPruneRegistryHealth` fails closed on
     * its own storage health. This projection was the one that dropped it.
     */
    complete: boolean;
    /**
     * Every registry named by ANY problem behind this observation, registry- or
     * unit-level. EMPTY means the incompleteness could not be attributed at all.
     *
     * `complete` alone says an observation was partial; it cannot say WHERE, and
     * a consumer that must not strand needs where. A destructive operation
     * refuses on an incompleteness that could involve the QUARANTINE registry —
     * the reset whose custody rule forbids the delete lives there — but an
     * incompleteness attributable solely to prune-registry units conceals no
     * such unit, and refusing on it would block a legitimate resume because of
     * unrelated residue in its own registry. That is the strand class this
     * program has hit three times, so the attribution is carried rather than
     * inferred, and an unattributable one is treated as unknown.
     */
    problemRegistries: readonly PreparationLifecycleUnitV1["registry"][];
  }
  | {
    status: "unavailable";
    detail: string;
    registries: readonly PreparationLifecycleUnitV1["registry"][];
  };

/**
 * Root-taking wrappers retained for the DESTRUCTIVE operation paths only.
 *
 * There is deliberately no generic root-taking scanner any more: a shared one is
 * what let a read consumer capture a second time inside a decision that already
 * held a read. Each wrapper below opens its own callback-scoped read directly, so
 * the capture is visible at the call site rather than hidden behind a helper.
 *
 * These exist to carry Tasks 9D/9E's explicit debt: quarantine and reset planning
 * still take a root. Prune/sweep planning does NOT — it opens its own read and
 * calls the pure projector — so no wrapper covers it, and the one that used to
 * was deleted as dead. These are not for read composition. A
 * read consumer must compose from one supplied read; see the structural control
 * in test/preparations/lifecycle-model/structural-controls.test.ts.
 */

/** Task 9D/9E operation wrapper: quarantine listing through one capture. */
export async function listQuarantineUnitsFromRoot(
  root: string,
): Promise<QuarantineUnitListingV1> {
  return withPreparationLifecycleRead(root, (read) => (read.status === "unavailable"
    ? { status: "unavailable" as const }
    : projectQuarantineUnits(read.snapshot)));
}

/** Task 9D/9E operation wrapper: unit pendingness through one capture. */
export async function quarantineUnitPendingFromRoot(
  root: string,
  unitId: string,
): Promise<boolean> {
  return withPreparationLifecycleRead(root, (read) => (read.status === "unavailable"
    ? true
    : projectQuarantineUnitPending(read.snapshot, unitId)));
}

/**
 * Whether one state is POSITIVE evidence that destructive work is unfinished.
 *
 * Deliberately excludes `unavailable`, which is a READ FAULT rather than an
 * observation of work in flight. The distinction only matters where the two are
 * ranked against each other — see {@link projectLifecyclePending} — because an
 * unreadable unit must be attributed to its registry's fault, not reported as a
 * unit someone can go and finish.
 */
function unitWorkPending(unit: PreparationLifecycleUnitV1): boolean {
  return unit.state === "awaiting-continuation" ||
    unit.state === "planned" ||
    unit.state === "applying";
}

/** Whether one state represents unfinished OR unreadable destructive work. */
function unitPending(unit: PreparationLifecycleUnitV1): boolean {
  return unitWorkPending(unit) || unit.state === "unavailable";
}

/**
 * THE pending-unit enumeration, and the only one.
 *
 * Every consumer that has to decide "which destructive units are unfinished, and
 * whose are they" reads this: the mutation gate's owner rule, the sweep target
 * selector shared by that gate and the sweep executor, and the joined projection
 * below. A second copy of this filter is exactly how a check and its executor
 * come to disagree about which units exist — the defect class §4 C3 exists to
 * close — so the filter has one home and the callers differ only in what they
 * ask of the result.
 */
export function projectPendingUnits(
  snapshot: PreparationLifecycleSnapshotV1,
): readonly LifecyclePendingUnitV1[] {
  return snapshot.units.filter(unitPending).map((unit) => ({
    registry: unit.registry, operation: unit.operation, unitId: unit.unitId,
  }));
}

/** First stable problem for one physical registry. */
function firstRegistryProblem(
  snapshot: PreparationLifecycleSnapshotV1,
  registry: "quarantine" | "prune",
): PreparationLifecycleProblemV1 | undefined {
  return snapshot.problems.find((problem) => problem.registry === registry);
}

/** Registry listing failed when its root or one direct unit entry is invalid. */
function quarantineListingUnavailable(
  snapshot: PreparationLifecycleSnapshotV1,
): boolean {
  return snapshot.problems.some((problem) =>
    problem.registry === "quarantine" &&
    (problem.unitId === undefined || problem.code === "unit-entry-unavailable"));
}

/** Project the legacy quarantine listing without re-reading its registry. */
export function projectQuarantineUnits(
  snapshot: PreparationLifecycleSnapshotV1,
): QuarantineUnitListingV1 {
  if (quarantineListingUnavailable(snapshot)) {
    return { status: "unavailable" };
  }
  return {
    status: "ok",
    unitIds: snapshot.units
      .filter((unit) => unit.registry === "quarantine")
      .map((unit) => unit.unitId),
  };
}

/** Project one legacy detective pendingness question from the snapshot. */
export function projectQuarantineUnitPending(
  snapshot: PreparationLifecycleSnapshotV1,
  unitId: string,
): boolean {
  const unit = snapshot.units.find((candidate) =>
    candidate.registry === "quarantine" && candidate.unitId === unitId);
  if (unit !== undefined) return unitPending(unit);
  return snapshot.problems.some((problem) =>
    problem.registry === "quarantine" && problem.unitId === undefined);
}

/** Project whether the prune registry's observation may be trusted. */
export function projectPruneRegistryHealth(
  snapshot: PreparationLifecycleSnapshotV1,
): PruneRegistryHealthV1 {
  const problem = firstRegistryProblem(snapshot, "prune");
  if (problem !== undefined) {
    return { status: "unavailable", detail: problem.detail };
  }
  // Physical storage health, not just classifier problems. This was the ONLY
  // lifecycle projector ignoring it. Several states set prune storage
  // unavailable while raising NO problem: a nested symlink or unreadable leaf
  // inside a safe-named unit, an unstable registry-root version, a
  // post-classification in-place size change. In those states this returned
  // "clean", and its consumer is the SWEEP DRIVER -- which then derives a new
  // sweep unit and runs a two-phase delete against a registry it could not
  // authoritatively observe. Fail closed instead.
  if (snapshot.storage.prune.health === "unavailable") {
    return { status: "unavailable", detail: "prune registry storage is unavailable" };
  }
  return { status: "ok" };
}

/**
 * Every physical registry whose observation cannot be trusted at the REGISTRY
 * level, attributed from the exact same predicate this projection has always used
 * to mean "registry fault": a problem naming no unit, or an unreadable direct
 * entry of the registry root.
 *
 * PHYSICAL STORAGE HEALTH IS DELIBERATELY NOT A TERM HERE, though it is tempting
 * and I had it wrong that way first. Health is also set by UNIT-level faults: an
 * unreadable unit root raises `unit-unavailable` for its own unit AND marks its
 * registry's storage unavailable. Unioning health in therefore reclassifies a
 * single bad unit as a whole faulted registry, which loses the unit — a
 * crash-interrupted quarantine whose unit directory went unreadable must still
 * read as PENDING work someone has to finish, not as an unreadable registry.
 *
 * Storage health still reaches this projection through `snapshot.complete`, whose
 * final arm reports unavailable with NO attribution — correct, because a fault
 * that names no registry has not been proven confined to one.
 */
function unobservableRegistries(
  snapshot: PreparationLifecycleSnapshotV1,
): readonly PreparationLifecycleUnitV1["registry"][] {
  const faulted = new Set<PreparationLifecycleUnitV1["registry"]>();
  for (const problem of snapshot.problems) {
    if (problem.unitId === undefined || problem.code === "unit-entry-unavailable") {
      faulted.add(problem.registry);
    }
  }
  return [...faulted];
}

/**
 * Project the joined lifecycle gate from one complete observation.
 *
 * OBSERVED PENDING WORK IS REPORTED BEFORE AN UNOBSERVABLE REGISTRY, which is the
 * opposite of the original order and deliberately so. A unit seen `planned`,
 * `applying` or `awaiting-continuation` is positive evidence of unfinished
 * destructive maintenance, and a faulted SIBLING registry does not make that
 * evidence less true. Reporting the fault first let a real pending unit hide
 * behind a degraded prune registry, and any consumer that treats a confined prune
 * fault as benign would then walk straight past it.
 *
 * Only that positive evidence takes precedence. An `unavailable` UNIT is a read
 * fault, so it stays behind the registry attribution — otherwise a planted
 * unreadable entry would be reported as a unit an operator could go and finish,
 * and the registry fault that actually caused it would never be named. It is
 * still reported as pending afterwards, preserving the fail-closed treatment of
 * an unreadable unit in a registry that is otherwise healthy.
 *
 * The pending list may be INCOMPLETE when a registry is unobservable; that is why
 * `registries` is carried on the unavailable arm rather than the absence of
 * pending units being read as proof there is none.
 *
 * THE PENDING ARM CARRIES EVERY PENDING UNIT, not only the ones that decided the
 * status. The ordering above decides WHICH STATUS wins; it is not a claim about
 * which units exist, and reporting a shorter list than {@link projectPendingUnits}
 * saw would give the gate's owner rule a different unit set from the executors'
 * — the two-enumerations shape this projection exists to remove.
 */
export function projectLifecyclePending(
  snapshot: PreparationLifecycleSnapshotV1,
): LifecyclePendingStateV1 {
  const pending = projectPendingUnits(snapshot);
  // BUILT ONCE, FOR EVERY ARM. Computing the attribution only on the path that
  // returns `unavailable` is what made the pending arm silent about a faulted
  // registry: the ranking above decides which STATUS wins, and a consumer that
  // read the winner as proof about the loser had no way to know better.
  const pendingArm = {
    status: "pending" as const,
    units: pending,
    unobservableRegistries: unobservableRegistries(snapshot),
    complete: snapshot.complete,
    problemRegistries: [...new Set(snapshot.problems.map((problem) => problem.registry))],
  };
  if (snapshot.units.some(unitWorkPending)) return pendingArm;
  const registries = pendingArm.unobservableRegistries;
  if (registries.length > 0) {
    return {
      status: "unavailable",
      registries,
      detail: snapshot.problems[0]?.detail ??
        `preparation lifecycle registry is unavailable: ${registries.join(", ")}`,
    };
  }
  if (pending.length > 0) return pendingArm;
  return snapshot.complete
    ? { status: "clean" }
    : {
      status: "unavailable",
      registries: [],
      detail: snapshot.problems[0]?.detail ?? "preparation lifecycle snapshot is incomplete",
    };
}

/**
 * Whether GC must hold for unfinished or unreadable lifecycle authority.
 *
 * The `!snapshot.complete` disjunct is NOT redundant, despite two rounds of
 * adversarial attempts failing to isolate it. Every non-racy storage fault is
 * independently rejected — prune faults by the closed-inventory check, quarantine
 * faults by the `quarantine-storage` problem — so both disjuncts fire together in
 * every state anyone has built. The only paths found across those two rounds where
 * it is solely load-bearing both require concurrent mutation: `enumerateRegistryRoot`
 * marking a registry unstable without pushing a problem, and `identityConflict`
 * seeing one inode at two sizes. That is the result of a search, not a proof of
 * exhaustiveness — but it is reason enough not to delete this on a dead-code pass.
 */
export function snapshotHasPendingLifecycle(
  snapshot: PreparationLifecycleSnapshotV1,
): boolean {
  return !snapshot.complete || snapshot.units.some(unitPending);
}

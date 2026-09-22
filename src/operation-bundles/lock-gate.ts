/**
 * @file src/operation-bundles/lock-gate.ts
 * @description The shared recovery gate that wraps every public mutating project-
 * lock acquisition. After acquiring the raw lock it strictly recovers the page
 * journal FIRST (INV-13), then — for any non-recovery intent — refuses to proceed
 * while an operation bundle needs recovery. The blocking set is exactly the three
 * UNSETTLED run states, where an effect can be live and an unrelated mutation could
 * invalidate a recovery observation: a run left `applying` by a crash, a run left
 * `compensating` by a crash mid-compensation, and a parked `recovery-required` run.
 * An integrity-invalid run or a missing/unreadable operation key also block. Every
 * such case blocks with `bundle-recovery-blocking`. The six other non-blocking run
 * states are the pre-effect states with no live effect (`awaiting-approval`,
 * `approved`, `approval-invalidated`) and the terminal states that need no further
 * recovery (`succeeded`, `succeeded-with-warnings`, `rejected`, `superseded`,
 * `cancelled`, `compensated`, `failed`, `recovered`, `abandoned`). Quarantine receipt
 * machinery does not exist at this milestone, so "no receipts" is treated as "no
 * pending quarantine" and never blocks. It then refuses while PREPARATION
 * LIFECYCLE MAINTENANCE is unfinished — a two-phase quarantine, key reset, prune
 * or sweep that planned work it has not completed — because only the owning
 * explicitly-confirmed command may resume one, so an unrelated mutation must wait
 * rather than race it. An unreadable lifecycle state also refuses, EXCEPT when the
 * fault is proven confined to the prune registry, which degrades by design; that
 * leg documents both halves. Finally it settles any completable
 * preparation handoff, which does not block. On any gate failure the acquired
 * lock is released before throwing. The gate itself acquires nothing beyond the
 * one raw lock and never re-enters this wrapper, so recovery stays non-recursive.
 */

import { acquireLock, acquireLockBlocking, releaseLock, type AcquireLockOptions, type BlockingLockOptions } from "../utils/lock.js";
import { JournalUnsafeError, recoverJournalBeforeCompile } from "../trust/journal-recovery.js";
import { resolvePreparationLifecyclePending, settlePreparationHandoffsLocked } from "../preparations/recovery.js";
import type { LifecyclePendingUnitV1, PreparationLifecyclePendingState } from "../preparations/recovery.js";
import { selectSweepTargetUnit } from "../preparations/lifecycle-snapshot/sweep-target.js";
import type { PreparationLifecycleOperationV1 } from "../preparations/lifecycle-snapshot/types.js";
import { scanOperationInventory } from "./capacity.js";
import { legacyPrivateAliasHasNoEntries } from "../utils/legacy-private-layout.js";
import { PREPARATION_QUARANTINE_SEGMENT, PREPARATION_PRUNE_REGISTRY } from "../preparations/paths.js";
import { readOperationKey } from "./key-epoch.js";
import { operationManifestDigest } from "./manifest-parse.js";
import type { OperationProblemCode } from "./problems.js";
import { readOperationRun } from "./run-store.js";
import { UNSETTLED_RUN_STATES } from "./run-validation.js";
import type { OperationBundleManifest } from "./types.js";

/**
 * The class of mutation acquiring the lock. `recovery` bypasses the whole gate
 * (it owns the re-drive); `handoff` runs the page-journal and Milestone A legs but
 * DEFERS the preparation-recovery leg to the handoff command, which resolves its
 * own run's `handoff-started` state rather than being blocked by it.
 */
export type RecoveryGateIntent =
  | "ordinary" | "review" | "recovery" | "quarantine" | "sweep" | "prune" | "handoff"
  | "reset";

/** Typed refusal when the recovery gate blocks a mutation from proceeding. */
export class RecoveryGateError extends Error {
  constructor(readonly code: OperationProblemCode, message: string) {
    super(message);
    this.name = "RecoveryGateError";
  }
}

/**
 * Typed refusal when UNFINISHED preparation lifecycle maintenance blocks a
 * mutation. It extends {@link RecoveryGateError} so every existing catcher of a
 * gate refusal keeps working. It carries the existing `quarantine-pending` code
 * because `OPERATION_PROBLEM_CODES` is a frozen registry owned outside this file.
 */
export class PreparationLifecycleGateError extends RecoveryGateError {
  constructor(message: string) {
    super("quarantine-pending", message);
    this.name = "PreparationLifecycleGateError";
  }
}

/**
 * Refusal because the lifecycle observation could not be TRUSTED, as opposed to
 * because of what it showed.
 *
 * A SUBCLASS RATHER THAN A NEW PROBLEM CODE, and additive either way: every
 * gate refusal carries `quarantine-pending` because `OPERATION_PROBLEM_CODES`
 * is a frozen registry owned outside this file, so unavailability, ownership,
 * unknown provenance and reset custody were structurally indistinguishable —
 * a reviewer could only establish which branch fired by building fixtures where
 * the others could not. That works once and does not survive into the suite.
 * `instanceof` makes the branch directly assertable, and every existing catcher
 * of {@link PreparationLifecycleGateError} and {@link RecoveryGateError} keeps
 * working unchanged.
 *
 * It matters most for the one refusal that must not be satisfiable by accident:
 * a destructive call refused via run-lookup, key state or generic ownership
 * looks identical from the outside to one refused on observability, and only
 * the second means the bypass is closed.
 */
export class PreparationLifecycleUnobservableError extends PreparationLifecycleGateError {
  constructor(message: string) {
    super(message);
    this.name = "PreparationLifecycleUnobservableError";
  }
}

/** How many pending unit ids one refusal message names before summarizing. */
const NAMED_PENDING_UNITS = 3;

/** Name the pending units without letting a large registry unbound the message. */
function pendingUnitSummary(units: readonly LifecyclePendingUnitV1[]): string {
  const named = units.slice(0, NAMED_PENDING_UNITS).map((unit) => unit.unitId).join(", ");
  const rest = units.length - NAMED_PENDING_UNITS;
  return rest > 0 ? `${named} and ${rest} more` : named;
}

/**
 * The intents that OWN a lifecycle unit, and may therefore resume their own.
 *
 * Every other intent refuses while anything is pending — that is unchanged. What
 * is new is that these three do not, because a destructive operation that cannot
 * resume its own crashed unit is the guard-that-strands class: the unit can only
 * be finished by the command that owns it, and that command is the one being
 * refused.
 *
 * `quarantine` HAS NO CALLER IN `src/` TODAY, and that is recorded rather than
 * quietly true. It is not the same case as the `reset`/`purge` intents this
 * revision declined to add: those would be tokens with no operation behind them
 * anywhere, whereas `quarantinePreparationRunLocked` is a complete shipped
 * operation whose only missing piece is a surface. Including it here costs
 * nothing and is a mapping the owner rule needs to be TOTAL — the alternative is
 * a partial table whose gap is discovered by whoever adds that surface. It is
 * exercised at the gate directly, so the row is tested rather than assumed.
 */
export type DestructiveGateIntent = "quarantine" | "prune" | "sweep";

/**
 * The intent whose authority is over the PROJECT rather than over a unit.
 *
 * ITS OWN CATEGORY, because it is neither of the other two and forcing it into
 * either produced a defect. Design v10 §4 states it in the heading of the rule
 * that governs it: *"one universal existential rule is wrong because reset is
 * PROJECT-scoped, not unit-scoped."* Its receipt enumerates project scope and
 * its protocol supersedes a SET of intent-only units, so no single unit id can
 * describe what it is authorized to touch.
 *
 * TREATING IT AS DESTRUCTIVE ROUTED IT THROUGH THE PER-UNIT OWNER RULE, where a
 * derived-null target could match no pending unit and any OTHER operation's
 * pending unit refused it — a crashed prune made the key unrepairable, stranding
 * both. Treating it as non-destructive would be worse: that arm refuses whenever
 * anything at all is pending.
 */
export type ProjectScopedGateIntent = "reset";

/** Every other intent: it owns no unit, so any pending unit refuses it. */
export type NonDestructiveGateIntent =
  Exclude<RecoveryGateIntent, DestructiveGateIntent | ProjectScopedGateIntent>;

/** The unit operation a key reset records, named once and read by the rules below. */
const RESET_UNIT_OPERATION = "project-key-reset" as const;

/**
 * Intent -> the unit operation it owns. TOTAL over the PER-UNIT destructive
 * intents, and the ONE place those two vocabularies are related (design v10
 * §4 C2).
 *
 * `reset` IS NOT IN THIS TABLE AND MUST NOT BE PUT BACK, which is worth saying
 * here because it was, and this docblock argued for it at length. It claimed
 * that reset "owning" `project-key-reset` was what let a stopped reset acquire
 * the ticket for its OWN pending unit and finish. **That model is RETRACTED**
 * (reconciliation R-11): reset is PROJECT-scoped, so it owns no unit, receives
 * no ticket, and does not appear in the per-unit vocabulary at all.
 *
 * WHAT THE RETRACTED ENTRY ACTUALLY COST, both reproduced: a pending unit
 * belonging to a DIFFERENT operation — a genuinely crashed prune — refused the
 * reset outright, stranding the broken key and the prune together; and the
 * ticket reset did receive named one unit while the executor completed another,
 * invisibly, because nothing consumed it.
 *
 * The paragraph's own reasoning was sound about the thing it was looking at:
 * this table IS the authority that `isDestructiveIntent` derives from, and a
 * union member without an entry here still compiles. That remains true and is
 * why `reset` is excluded from `DestructiveGateIntent` itself rather than merely
 * omitted here — a per-unit reset ticket is now unrepresentable, not just
 * absent. What the paragraph never asked was whether reset belonged in this
 * vocabulary at all.
 */
const DESTRUCTIVE_INTENT_OPERATION = {
  quarantine: "per-run-quarantine",
  prune: "run-prune",
  sweep: "orphan-sweep",
} as const satisfies Record<DestructiveGateIntent, PreparationLifecycleOperationV1>;

/** Whether this intent owns a lifecycle unit, derived from the table itself. */
function isDestructiveIntent(intent: RecoveryGateIntent): intent is DestructiveGateIntent {
  return Object.hasOwn(DESTRUCTIVE_INTENT_OPERATION, intent);
}

/**
 * The unit a gated destructive acquisition is RESUMING, or `null` for a fresh
 * start with no unfinished work to inherit.
 *
 * It is produced by the gate and consumed by the executor, which compares it
 * against the unit its own capture resolves and refuses divergence. That
 * comparison is the whole point: the gate authorized a named unit, and an
 * executor acting on a different one would be destroying bytes nothing approved.
 */
export interface LifecycleGateTicketV1 {
  readonly operation: PreparationLifecycleOperationV1;
  readonly unitId: string;
}

/**
 * A destructive authorization: the QUESTION the gate was asked and the ANSWER it
 * gave, travelling together.
 *
 * A TICKET ALONE OUTLIVES ITS JUSTIFICATION. The gate decides against one
 * observed lifecycle state; an executor holding only the verdict cannot tell
 * whether that state still holds, and the two paths degraded differently for
 * exactly that reason — `sweep` re-checked a narrower projection than the gate
 * used, and `prune` carried a boolean and re-checked nothing. Both are distances
 * along one axis: how much of the decision survived the boundary.
 *
 * Carrying the inputs as well as the verdict is what lets an executor re-run
 * {@link evaluateDestructiveAuthorization} — the gate's OWN predicate — against
 * its own snapshot, rather than composing a check that merely resembles it. Two
 * checks that agree by construction are one control; two that agree by
 * inspection are a coincidence.
 */
export interface LifecycleAuthorizationV1 {
  /** The intent the gate authorized. */
  readonly intent: DestructiveGateIntent;
  /** The target the caller derived from its own request, as the gate saw it. */
  readonly targetUnitId: string | undefined;
  /** The gate's verdict: the unit that may be resumed, or `null` for a fresh start. */
  readonly ticket: LifecycleGateTicketV1 | null;
}

/**
 * Refuse while preparation lifecycle maintenance is UNFINISHED.
 *
 * A pending unit means a two-phase destructive operation (quarantine, key reset,
 * prune, sweep) planned work it has not completed, so its objects are mid-move
 * and an unrelated mutation could invalidate the observation its continuation
 * depends on. Unlike handoff settlement below, this is NEVER auto-resumed here:
 * only the owning explicitly-confirmed command may finish it, which is why this
 * refuses rather than settles.
 *
 * This leg is the NON-OWNING one: `ordinary`, `review` and `handoff` own no
 * lifecycle unit, so any pending unit refuses them. `recovery` has already
 * returned by the time this runs and must reach the state to diagnose it. The
 * three destructive intents route to {@link destructiveTicket} instead.
 *
 * AN UNREADABLE STATE REFUSES UNLESS THE FAULT IS PROVEN CONFINED TO PRUNE.
 * A prune registry that cannot be BOUND — a symlink, a regular file, a drifted
 * identity — degrades to prune-specific unavailable state on purpose: prune sits
 * outside quarantine totals and outside the key-epoch compatibility sum, so
 * binding the two registries together and rejecting the whole read is a
 * regression this project already fixed once. The consumers that genuinely need
 * prune (status, reference completeness/GC, the sweep driver) each stay
 * fail-closed themselves, and MUTATE-mode capture refuses outright. Refusing
 * every ordinary mutation on that fault would re-break staging and the
 * unconditional handoff settlement below for a fault neither one touches.
 *
 * An unobservable QUARANTINE registry is the opposite case and must refuse: it can
 * hide a pending per-run quarantine or key reset, so proceeding would race exactly
 * the destructive work this leg exists to serialize against. Treating both origins
 * as one opaque `unavailable` is what made the earlier revision fail OPEN there.
 */
function refusePendingPreparationLifecycle(pending: PreparationLifecyclePendingState): void {
  if (pending.status === "clean") return;
  if (pending.status === "pending") {
    throw new PreparationLifecycleGateError(
      "preparation lifecycle maintenance is unfinished; complete the destructive operation that owns " +
        `${pendingUnitSummary(pending.units)} before this mutation`,
    );
  }
  if (degradesToPruneOnly(pending.registries)) return;
  throw new PreparationLifecycleGateError(
    "preparation lifecycle maintenance state could not be read, so this mutation cannot proceed: " +
      pending.detail,
  );
}

/**
 * The unit one destructive acquisition would act on, derived rather than trusted.
 *
 * PRUNE AND QUARANTINE derive theirs from the request's own run binding, through
 * the same pure function their executor uses, so the ticket and the unit that
 * gets mutated cannot be different objects. SWEEP derives its target HERE, from
 * the capture taken under the acquired lock, because its target is an
 * observation of the registry rather than a function of the request — and a
 * pre-lock scan would select one unit while the executor's own capture selected
 * another.
 *
 * A CALLER-SUPPLIED SWEEP TARGET IS REFUSED OUTRIGHT rather than ignored. If the
 * field could be quietly discarded, a future caller that started setting it
 * would believe it was aiming the operation while the gate aimed it elsewhere.
 */
function destructiveTarget(
  intent: DestructiveGateIntent,
  supplied: string | undefined,
  units: readonly LifecyclePendingUnitV1[],
): { readonly ok: true; readonly unitId: string | null } | { readonly ok: false; readonly detail: string } {
  if (intent === "sweep") {
    if (supplied !== undefined) {
      return { ok: false, detail: "a sweep target is derived under the lock and may not be supplied by a caller" };
    }
    const selected = selectSweepTargetUnit(units);
    return selected.status === "blocked"
      ? { ok: false, detail: selected.detail }
      : { ok: true, unitId: selected.unitId };
  }
  return supplied === undefined
    ? { ok: false, detail: `a ${intent} acquisition must derive its target unit from its own request` }
    : { ok: true, unitId: supplied };
}

/**
 * Whether the request OWNS the pending work, decided PER UNIT (design v10 §4).
 *
 * The rule is existential over the request's own target, not universal over the
 * pending set. `unitPending` spans BOTH registries, so a pending quarantine unit
 * and a pending prune unit co-exist after a crash mid-prune — and under a
 * universal rule no single owner matches both, every owner is refused, and
 * neither unit can ever be finished. That is the guard-that-strands class
 * reintroduced by a quantifier, so other pending units do not block an owner.
 *
 * THE ONE EXCEPTION IS RESET, and it is not an exception to fail-closed
 * reasoning but to the per-unit shape. A `project-key-reset` unit is
 * PROJECT-scoped: its receipt enumerates project scope and the leaves of every
 * other destructive unit become its custody, so serializing behind the lock does
 * not make the others independent of it. It therefore refuses every intent that
 * reaches this function — which is every PER-UNIT destructive intent, and all of
 * them, without exception.
 *
 * `reset` DOES NOT REACH THIS FUNCTION, and the sentence that used to end this
 * paragraph is why the distinction is spelled out: it said reset refuses "all of
 * them" *"because no reset surface ships"*. A reset surface ships now, and that
 * clause was a precondition being read as a property even when it was true.
 * Reset takes the project-scoped arm of `gatePreparationLifecycle` before the
 * destructive split, so it never arrives here to be refused or exempted — which
 * is why no owner exemption is needed below.
 */
function ownerTicket(
  intent: DestructiveGateIntent,
  targetUnitId: string | null,
  units: readonly LifecyclePendingUnitV1[],
): LifecycleGateTicketV1 {
  const operation = DESTRUCTIVE_INTENT_OPERATION[intent];
  const owned = units.find((unit) => unit.unitId === targetUnitId && unit.operation === operation);
  // AN OWNER PROCEEDS PAST AN UNKNOWN UNIT, AND SWEEP DOES NOT — the two verbs
  // genuinely disagree about one registry state, so the reason is written down
  // rather than inherited.
  //
  // The difference is in how each verb's TARGET is established. Prune's is a
  // pure function of the run id in its request, so it needs no observation of
  // the registry at all: it acts on its own unit's signed plan and touches
  // nothing else, and an unrelated unit of unknown provenance is not evidence
  // about it. Sweep's target is DERIVED BY OBSERVING that registry, so a unit it
  // cannot classify makes the derivation itself untrustworthy — which is why the
  // shared selector blocks on any non-sweep unit, a rule that predates this
  // change and is not weakened by it.
  //
  // Neither verb ever treats the unknown unit as permission — it can never be
  // anyone's ticket, and that is what "absent provenance is not permission"
  // means. Making prune block on it instead would strand a legitimate resume
  // behind an unrelated unit in its own registry, which is the same class this
  // whole rule exists to avoid.
  if (owned !== undefined) return { operation, unitId: owned.unitId };
  // ABSENT PROVENANCE IS NOT PERMISSION, and it is named rather than folded into
  // the generic refusal: a unit whose operation could not be established is
  // owned by nobody, so no shipped verb can retire it and an operator reading a
  // generic "complete the operation that owns it" would go looking for one.
  const unknown = units.find((unit) => unit.operation === null);
  if (unknown !== undefined) {
    throw new PreparationLifecycleGateError(
      `preparation lifecycle unit ${unknown.unitId} has no recorded operation, so no destructive command owns it; ` +
        "it needs operator escalation rather than a resume",
    );
  }
  throw new PreparationLifecycleGateError(
    `preparation lifecycle maintenance is unfinished and this ${intent} owns none of it; ` +
      `complete the destructive operation that owns ${pendingUnitSummary(units)} first`,
  );
}

/**
 * The one refusal a destructive intent gives for an untrustworthy observation.
 *
 * SHARED so both arms say the same thing. Two messages for one fact is how a
 * caller comes to handle one and miss the other, and these two arms are exactly
 * the pair that already diverged once.
 */
function unreadableLifecycle(intent: DestructiveGateIntent, detail: string): PreparationLifecycleGateError {
  return new PreparationLifecycleUnobservableError(
    `preparation lifecycle maintenance state could not be read, so ${intent} cannot proceed: ${detail}`,
  );
}

/**
 * Refuse when a VISIBLE key reset holds custody of everyone else's leaves.
 *
 * RUN BEFORE THE OBSERVABILITY GATE, and the ordering only picks a message
 * because both answers refuse. When the reset can be SEEN, naming the unit an
 * operator has to finish is strictly more useful than naming a registry that
 * could not be read. When it is HIDDEN — which is the whole bypass this gate
 * exists under — this cannot fire, and the observability refusal is what
 * answers. So the more specific message wins exactly where it is true.
 */
function refuseVisibleResetCustody(
  intent: DestructiveGateIntent, units: readonly LifecyclePendingUnitV1[],
): void {
  // NO OWNER EXEMPTION IS NEEDED HERE ANY MORE. This rule protects every
  // destructive unit from a reset holding custody of its leaves, and `reset`
  // itself no longer reaches it: it is project-scoped and takes its own arm of
  // `gatePreparationLifecycle` before this function is called. The exemption
  // that used to sit here existed only because reset was misclassified as a
  // per-unit destructive intent.
  const reset = units.find((unit) => unit.operation === RESET_UNIT_OPERATION);
  if (reset === undefined) return;
  throw new PreparationLifecycleGateError(
    `preparation key reset ${reset.unitId} is unfinished and holds custody of every other destructive unit's leaves; ` +
      `complete the reset before running ${intent}`,
  );
}

/**
 * Authorize one destructive acquisition and hand back the unit it may resume.
 *
 * AN UNREADABLE REGISTRY REFUSES EVERY DESTRUCTIVE INTENT, including the
 * prune-confined fault that ordinary mutations degrade past — and the divergence
 * from D-10-15's isolation clause is deliberate. Proceeding needs POSITIVE
 * evidence about both registries, not the absence of contrary evidence: an
 * unobservable quarantine registry can hide the `project-key-reset` unit whose
 * custody rule above is the only thing stopping this operation from deleting
 * leaves the reset has claimed, and an unobservable prune registry can hide this
 * operation's own unfinished unit. D-10-15 would have a prune resume proceed
 * while its sibling registry is exhausted; that and the reset-ordering rule
 * cannot both hold in the state D-10-15 names, and a destructive path takes the
 * fail-closed side. Nothing is stranded by it: the `recovery` intent still
 * reaches the state to diagnose it.
 *
 * IT IS CHECKED ON BOTH ARMS, and the first version checked only one — which
 * made it dead in exactly the state it was written for. A faulted registry and
 * observed pending work co-occur, the status can report only one of them, and
 * the pending arm wins; so a crashed prune beside an unreadable quarantine
 * registry took the pending arm, never reached the `unavailable` check, matched
 * its own unit, and deleted the bytes. Reproduced end to end before this fix:
 * three objects, 7,317 bytes, gone. The very fixture D-10-15 names — one
 * registry faulted, a pending unit in the other — is the shape that got past it,
 * which is what a claim tested on one member of a set looks like from the
 * inside.
 */
export function evaluateDestructiveAuthorization(
  intent: DestructiveGateIntent,
  targetUnitId: string | undefined,
  pending: PreparationLifecyclePendingState,
): LifecycleGateTicketV1 | null {
  if (pending.status === "unavailable") {
    throw unreadableLifecycle(intent, pending.detail);
  }
  if (pending.status === "pending") {
    refuseVisibleResetCustody(intent, pending.units);
    // BOTH SIGNALS, because neither subsumes the other and each closes a state
    // the other leaves open. A registry-level fault attributes and lands in
    // `unobservableRegistries` — that is the case where a pending unit in one
    // registry sits beside a sibling registry nobody could enumerate. A
    // UNIT-level fault attributes nothing and only shows up as an incomplete
    // observation, which is what an unreadable unit directory produces. R-9
    // requires the refusal "for EITHER registry and for an unattributable
    // fault", and that is all three arms.
    if (pending.unobservableRegistries.length > 0) {
      throw unreadableLifecycle(intent, `${pending.unobservableRegistries.join(", ")} registry is unavailable`);
    }
    // THE INCOMPLETENESS MUST BE PROVEN CONFINED TO PRUNE TO BE PASSED OVER,
    // through the SAME predicate the ordinary leg uses — called, not restated,
    // so the two cannot come to mean different things. Positive evidence, so an
    // unattributable incompleteness refuses.
    //
    // The confinement is what keeps this from stranding: a prune unit that lost
    // its planned receipt is residue no verb can retire, and refusing every
    // prune resume in its registry because of it would block legitimate work
    // for a fault that conceals nothing. A key reset lives in the QUARANTINE
    // registry, so only an incompleteness that could involve THAT registry can
    // be hiding the unit which forbids this delete.
    // AN UNATTRIBUTED INCOMPLETENESS REFUSES, because `degradesToPruneOnly`
    // demands a NON-EMPTY set: empty means the fault could not be placed at all,
    // which is not evidence of confinement. That is R-9's third arm, and it
    // falls out of the confinement rule rather than needing a clause of its own.
    //
    // THE UNEXERCISABLE SIBLINGS ARE A CLOSED DISPOSITION, NOT A BACKLOG ITEM.
    // Three paths reach `complete: false` with no problem raised — registry-entry
    // exhaustion at the 100,000 ceiling, `enumerateRegistryRoot`'s own
    // instability window, and an identity conflict seeing one inode at two sizes.
    // Every one needs the perturbation to land INSIDE a paired before/after
    // observation, and every test seam fires BETWEEN phases; a fourth
    // between-phase hook would not help, and a seam inside a paired observation
    // is exactly what this read authority's one-field options type exists to
    // refuse. One route is exercised and that is sufficient, because THIS ARM
    // KEYS ON THE STATE RATHER THAN THE ROUTE and all three converge on the
    // identical observable state.
    // SECOND CALL SITE, and the coupling is worth seeing before editing either.
    // `degradesToPruneOnly`'s `length > 0` is what makes it fail closed on an
    // EMPTY set — `[].every(...)` is `true`, so that token looks like defensive
    // noise and is the most deletable thing in the file. It is not: deleting it
    // makes an unattributed fault read as prune-confined, which silently relaxes
    // BOTH this arm and the pre-existing `unavailable` branch above, whose
    // semantics differ. Each call site now has its own witness — delete the
    // token and two tests go red, one per site.
    if (!pending.complete && !degradesToPruneOnly(pending.problemRegistries)) {
      throw unreadableLifecycle(intent, "the observation is incomplete, so a unit may be unaccounted for");
    }
  }
  // BEFORE THE CLEAN SHORT-CIRCUIT, deliberately. Checking the caller's own
  // derivation only when something happened to be pending made the check
  // order-dependent: a caller that never derived a target sailed through every
  // clean project and was refused only once a crash gave the gate something to
  // compare against. A contract that holds in one state is not a contract.
  const units = pending.status === "pending" ? pending.units : [];
  const target = destructiveTarget(intent, targetUnitId, units);
  if (!target.ok) throw new PreparationLifecycleGateError(target.detail);
  if (units.length === 0) return null;
  return ownerTicket(intent, target.unitId, units);
}

/**
 * The lifecycle leg of the gate, over THREE intent categories rather than two.
 *
 * A per-unit destructive intent is refused unless it owns the pending unit it
 * named, and authorized with that unit's ticket. A non-destructive intent is
 * refused while anything is pending. And a PROJECT-SCOPED intent — `reset`, the
 * only one — is authorized by the project lock itself and returns no ticket.
 *
 * THE THIRD CATEGORY IS NEW AND REPLACES A WRONG ONE. Reset was briefly routed
 * through the per-unit arm, where a null derived target matched no pending unit
 * and another operation's crashed unit refused it outright. Its arm is taken
 * FIRST here, so no per-unit rule can reach it (reconciliation R-11).
 *
 * ONE observation serves the per-unit arms. The pending state and the sweep
 * target are projected from the SAME capture, so the gate cannot authorize
 * against a registry it read twice.
 */
async function gatePreparationLifecycle(
  root: string, intent: RecoveryGateIntent, targetUnitId: string | undefined,
): Promise<LifecycleGateTicketV1 | null> {
  // THE PROJECT-SCOPED ARM, TAKEN FIRST (§4 reset ordering). `reset` is neither
  // per-unit destructive nor non-destructive, and both of the other arms are
  // wrong for it: the destructive arm demands a unit it owns, the
  // non-destructive arm refuses whenever anything is pending. Its authorization
  // IS the project lock plus the protocol's own under-lock recheck, so it
  // returns no ticket and no pending unit refuses it.
  //
  // "Pending prune/sweep/quarantine units do NOT block reset. Reset exists
  // precisely for the broken-key state in which other pending work cannot be
  // trusted; blocking it on their pendingness would deadlock the one project
  // state reset exists to repair." — design v10 §4, quoted because this
  // function previously did the opposite.
  //
  // THE OTHER DIRECTION OF THAT RULE IS UNCHANGED and lives in
  // `refuseVisibleResetCustody`: a pending `project-key-reset` unit still
  // refuses every OTHER destructive intent, because their key epoch is the thing
  // being reset and their leaves become reset's custody.
  if (intent === "reset") return null;
  if (!isDestructiveIntent(intent) && await legacyPrivateAliasHasNoEntries(
    root, [PREPARATION_QUARANTINE_SEGMENT, PREPARATION_PRUNE_REGISTRY],
  )) return null;
  const pending = await resolvePreparationLifecyclePending(root);
  if (!isDestructiveIntent(intent)) {
    refusePendingPreparationLifecycle(pending);
    return null;
  }
  return evaluateDestructiveAuthorization(intent, targetUnitId, pending);
}

/**
 * Whether an unavailable observation is PROVEN confined to the prune registry.
 *
 * Relaxing a refusal requires positive evidence of confinement, never the absence
 * of evidence to the contrary. An empty set means the capture failed before it
 * could attribute the fault — the whole-read failure a symlinked quarantine root
 * produces, for one — so it is unknown origin and refuses.
 */
function degradesToPruneOnly(
  registries: readonly ("quarantine" | "prune")[],
): boolean {
  return registries.length > 0 && registries.every((registry) => registry === "prune");
}

/** The read-only recovery state a read surface reports without mutating any bytes. */
export type OperationRecoveryReadState =
  | "clean"
  | "applying-stale-recovery-pending"
  | "bundle-recovery-required";

/** The exact run binding for one inventoried manifest under the current key epoch. */
function bindingFor(manifest: OperationBundleManifest, keyEpochId: `sha256:${string}`) {
  return {
    runId: manifest.runId, bundleId: manifest.bundleId,
    manifestDigest: operationManifestDigest(manifest) as `sha256:${string}`,
    workspaceId: manifest.workspaceId, keyEpochId,
  };
}

/**
 * Detect whether any operation bundle needs recovery, returning the blocking
 * problem code or null when clean. The integrity-key and run-integrity classes are
 * enumerated as blocking and never collapsed to absent.
 */
/** The blocking code for one bundle's run, or null when it does not block. */
async function runRecoveryBlock(root: string, manifest: OperationBundleManifest, keyEpochId: `sha256:${string}`): Promise<OperationProblemCode | null> {
  const read = await readOperationRun(root, bindingFor(manifest, keyEpochId));
  if (read.status === "unavailable") return read.code ?? "run-integrity-invalid";
  // Block exactly the shared unsettled set — execution or recovery may have a live
  // effect an unrelated mutation could invalidate; pre-effect and terminal never block.
  if (read.status === "ok" && UNSETTLED_RUN_STATES.has(read.run.state)) return "bundle-recovery-blocking";
  return null;
}

async function detectBundleRecovery(root: string): Promise<OperationProblemCode | null> {
  const inventory = await scanOperationInventory(root);
  if (inventory.problems.length > 0) return "bundle-recovery-blocking";
  if (inventory.manifests.length === 0) return null;
  const key = await readOperationKey(root);
  if (key.status === "absent") return "integrity-key-missing";
  if (key.status === "unavailable") return "integrity-key-unreadable";
  for (const manifest of inventory.manifests) {
    const block = await runRecoveryBlock(root, manifest, key.keyEpochId);
    if (block !== null) return block;
  }
  return null;
}

/**
 * Run the journal + bundle recovery gate, throwing a typed refusal when it blocks.
 * The `recovery` intent owns both the page-journal revert and the bundle re-drive
 * itself (the recover coordinator has a runtime and reports its own outcome), so
 * the gate does not pre-empt it.
 */
async function runRecoveryGate(
  root: string, intent: RecoveryGateIntent, targetUnitId: string | undefined,
): Promise<LifecycleGateTicketV1 | null> {
  if (intent === "recovery") return null;
  // The unconditional recovery order (design section 15.1): page journal first,
  // then the Milestone A bundle coordinator, then preparation recovery. Preparation
  // recovery runs LAST so a bundle create that outran its `handed-off` transition
  // is discovered and completed rather than duplicated.
  const journal = await recoverJournalBeforeCompile(root);
  if (journal.status === "unsafe") {
    // Preserve the page-journal fail-closed contract callers already expect.
    throw new JournalUnsafeError("pre-mutation journal recovery unsafe");
  }
  const bundleBlock = await detectBundleRecovery(root);
  if (bundleBlock !== null) {
    throw new RecoveryGateError(bundleBlock, "operation bundle recovery is required before this mutation");
  }
  // BEFORE the settlement leg below, and before the handoff intent's early
  // return, so a refusal means nothing happened: settlement APPENDS durable
  // transitions, and appending them and then refusing would leave the project
  // mutated by an acquisition the caller was told did not proceed. The handoff
  // intent's exemption is from settling its OWN `handoff-started` run, not from
  // lifecycle maintenance — it owns no lifecycle unit either.
  const ticket = await gatePreparationLifecycle(root, intent, targetUnitId);
  // Preparation recovery settles a handoff whose bundle create outran its
  // `handed-off` transition, but never blocks: a parked or bundle-absent in-flight
  // handoff belongs to its own command's resume and cannot conflict with this
  // mutation, so blocking here would wrongly stall concurrent preparation work. The
  // handoff intent resolves its own run and skips this leg.
  if (intent === "handoff") return ticket;
  await settlePreparationHandoffsLocked(root);
  return ticket;
}

/** Run the gate; release the acquired lock before rethrowing any gate failure. */
async function gateOrRelease(
  root: string, intent: RecoveryGateIntent, targetUnitId: string | undefined,
): Promise<LifecycleGateTicketV1 | null> {
  try {
    return await runRecoveryGate(root, intent, targetUnitId);
  } catch (error) {
    await releaseLock(root);
    throw error;
  }
}

/**
 * The result of a gated destructive acquisition (design v10 §4 C3, v10 J1).
 *
 * THREE FACTS, NOT TWO, and collapsing any pair loses something a caller acts
 * on. `acquired: false` is a busy lock — nothing happened and a retry is
 * sensible. `acquired: true` with a `ticket` is a RESUME of named unfinished
 * work. `acquired: true` with a `null` ticket is a clean start: the lifecycle
 * held nothing to inherit. An earlier shape returned the ticket or `null` and
 * read a valid fresh start as contention.
 */
export type PreparationLockAcquisitionV1 =
  | { readonly acquired: false }
  | { readonly acquired: true; readonly authorization: LifecycleAuthorizationV1 };

/** Options for a destructive acquisition: lock options plus the derived target. */
export interface PreparationLockOptionsV1 extends AcquireLockOptions {
  /**
   * The unit this operation derived from its OWN request, for the intents whose
   * target is a function of the request. Never supplied for `sweep`, whose
   * target is observed under the lock — supplying one there is refused.
   */
  readonly targetUnitId?: string;
}

/**
 * Acquire the project lock for a DESTRUCTIVE preparation operation, pass the
 * recovery gate, and return the unit the gate authorized this call to resume.
 *
 * The boolean form below wraps this, so both share one gate and one owner rule.
 *
 * @param root - The project root being mutated.
 * @param intent - The destructive intent, which selects the unit operation owned.
 * @param options - Lock options plus this operation's own derived target unit.
 * @returns Busy, or acquired with the ticket to resume (or `null` to start fresh).
 */
export async function acquirePreparationMutationLock(
  root: string, intent: DestructiveGateIntent, options: PreparationLockOptionsV1 = {},
): Promise<PreparationLockAcquisitionV1> {
  const acquired = await acquireLock(root, options);
  if (!acquired) return { acquired: false };
  const ticket = await gateOrRelease(root, intent, options.targetUnitId);
  // THE QUESTION TRAVELS WITH THE ANSWER. Built here, from the values this
  // acquisition actually put to the gate, so no consumer can reconstruct a
  // target the gate never saw.
  return { acquired: true, authorization: { intent, targetUnitId: options.targetUnitId, ticket } };
}

/**
 * Acquire the project lock for a mutation and pass the recovery gate. Returns false
 * when the lock is busy (the raw fail-fast behavior is preserved); throws
 * {@link RecoveryGateError} when the gate blocks, having released the lock.
 *
 * A DESTRUCTIVE INTENT IS UNREPRESENTABLE HERE, rather than merely unused. This
 * form has nowhere to put a ticket, so taking one would let a caller acquire at
 * `prune` and then act on whatever unit its own capture happened to find —
 * exactly the unbound-ticket shape §4 C3 removed. Destructive callers use
 * {@link acquirePreparationMutationLock}, which cannot lose the ticket.
 *
 * `reset` IS ADMISSIBLE HERE, AND FOR THE SAME REASON RATHER THAN AN EXCEPTION
 * TO IT. Having nowhere to put a ticket disqualifies a PER-UNIT intent, whose
 * authorization is a specific unit. Reset's authorization is the project lock
 * plus its own under-lock recheck, so there is no ticket to lose — a ticket was
 * what it had to lose before, and losing it is precisely how the gate came to
 * authorize one unit while the executor mutated another.
 */
export async function acquireMutationLock(
  root: string, intent: NonDestructiveGateIntent | ProjectScopedGateIntent,
  options: AcquireLockOptions = {},
): Promise<boolean> {
  const acquired = await acquireLock(root, options);
  if (!acquired) return false;
  await gateOrRelease(root, intent, undefined);
  return true;
}

/**
 * Acquire the project lock (bounded-blocking) for a mutation and pass the recovery
 * gate. The busy/timeout behavior of the raw primitive is unchanged (it throws
 * LockBusyError); a gate block throws {@link RecoveryGateError} after releasing.
 */
export async function acquireMutationLockBlocking(root: string, intent: NonDestructiveGateIntent, options: BlockingLockOptions = {}): Promise<void> {
  await acquireLockBlocking(root, options);
  await gateOrRelease(root, intent, undefined);
}

/** One manifest's read-only recovery classification without any mutation. */
type ManifestRecoveryRead = "unavailable" | "stale-active" | "parked" | "settled";

/**
 * Classify one manifest's run for the read-only resolver: an unreadable leaf is
 * `unavailable`, an `applying`/`compensating` run is a crash-interrupted owner-held
 * `stale-active`, a `recovery-required` run is `parked`, and everything else
 * (pre-effect or terminal) is `settled`.
 */
async function manifestRecoveryRead(root: string, manifest: OperationBundleManifest, keyEpochId: `sha256:${string}`): Promise<ManifestRecoveryRead> {
  const read = await readOperationRun(root, bindingFor(manifest, keyEpochId));
  if (read.status === "unavailable") return "unavailable";
  if (read.status !== "ok" || !UNSETTLED_RUN_STATES.has(read.run.state)) return "settled";
  // Within the shared unsettled set, only `recovery-required` is the parked case; the
  // owner-held active states (`applying`/`compensating`) are stale-active.
  return read.run.state === "recovery-required" ? "parked" : "stale-active";
}

/**
 * Report the operation recovery state WITHOUT acquiring the lock or mutating any
 * bytes — the read-only resolver for status/review surfaces. An `applying` or
 * `compensating` run left by a stale owner reports `applying-stale-recovery-pending`
 * (both are crash-interrupted owner-held states awaiting a coordinator re-drive); a
 * parked `recovery-required` run reports `bundle-recovery-required`.
 */
export async function resolveOperationRecoveryState(root: string): Promise<OperationRecoveryReadState> {
  const inventory = await scanOperationInventory(root);
  if (inventory.problems.length > 0 || inventory.manifests.length === 0) {
    return inventory.problems.length > 0 ? "bundle-recovery-required" : "clean";
  }
  const key = await readOperationKey(root);
  if (key.status !== "ok") return "bundle-recovery-required";
  let parked = false;
  for (const manifest of inventory.manifests) {
    const classified = await manifestRecoveryRead(root, manifest, key.keyEpochId);
    if (classified === "unavailable") return "bundle-recovery-required";
    if (classified === "stale-active") return "applying-stale-recovery-pending";
    if (classified === "parked") parked = true;
  }
  return parked ? "bundle-recovery-required" : "clean";
}

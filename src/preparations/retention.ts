/**
 * @file src/preparations/retention.ts
 * @description Retention floor, prune, and orphan sweep (design sections 26.3,
 * 26.4). Terminal preparation bytes become prune-eligible only after the 30-day
 * floor measured by an INJECTABLE clock (never `Date.now`) AND a complete reference
 * check: a handed-off run is pruned only once its exact Milestone A bundle is
 * re-read and verified, and a `recovery-required` or integrity-invalid run is never
 * ordinarily pruned. Prune and sweep share one planned/completed, crash-resumable
 * two-phase discipline that deletes only the exact enumerated bytes and keeps a
 * signed tombstone. Sweep never treats an unreadable owner as absent: it reclaims
 * only a preparation whose run leaf is PROVABLY absent, never one merely unreadable.
 */

import type { LifecycleAuthorizationV1 } from "../operation-bundles/lock-gate.js";
import { createHash } from "node:crypto";
import { readOperationManifest } from "../operation-bundles/manifest-store.js";
import { assertBundleId } from "../operation-bundles/ids.js";
import { readPreparationKey } from "./key-epoch.js";
import { readPreparationManifest } from "./manifest-store.js";
import { preparationManifestDigest } from "./manifest-parse.js";
import {
  assertConfinedPruneUnit, readVerifiedPruneReceipt,
} from "./lifecycle-fs/prune-protocol.js";
import {
  pruneUnitIdFor, sweepUnitIdFor,
  type DeleteFaultsForTest,
} from "./prune-delete.js";
import {
  runLifecycleCustodyOperation,
  type LifecycleCustodyAdapter, type LifecycleGoverningKey,
} from "./lifecycle-driver.js";
import type { PreparationLifecycleReadV1 } from "./lifecycle-snapshot/read.js";
import type { PreparationLifecycleSnapshotV1 } from "./lifecycle-snapshot/types.js";
import {
  projectPendingUnits, projectPruneRegistryHealth,
} from "./lifecycle-snapshot/compat.js";
import { selectSweepTargetUnit } from "./lifecycle-snapshot/sweep-target.js";
import { readPreparationRun } from "./run-store.js";
import { enumerateRunScope, scanForDestructivePlan, scopedLeafObject } from "./quarantine.js";

import type { PruneReceiptContentV1, PruneReceiptV1 } from "./receipts.js";
import type { ScopedQuarantineObject } from "./quarantine-move.js";
import type { PreparationPrincipalV1, PreparationRunBinding, PreparationRunState } from "./run-types.js";

/** The default terminal retention floor: 30 days measured by an injected clock. */
const PREPARATION_RETENTION_FLOOR_MS = 30 * 24 * 60 * 60 * 1000;

/** A deterministic injected clock; retention arithmetic never reads `Date.now`. */
export interface LifecycleClock { now(): Date }

const TERMINAL_STATES = new Set<PreparationRunState>([
  "handed-off", "succeeded", "succeeded-with-warnings", "failed", "cancelled",
  "cancelled-with-effects", "superseded", "abandoned",
]);

/** The complete prune-eligibility decision with its fail-closed reason. */
export interface PruneEligibility { eligible: boolean; reason: string }

/**
 * Decide whether a run's bytes are prune-eligible under the injected clock. A run
 * must read valid, be terminal, clear the retention floor, and — when handed off —
 * have its exact Milestone A bundle verified present, so a byte a surviving bundle
 * still owns is never reclaimed.
 */
export async function pruneEligibility(root: string, binding: PreparationRunBinding, clock: LifecycleClock): Promise<PruneEligibility> {
  const read = await readPreparationRun(root, binding);
  if (read.status !== "ok") return { eligible: false, reason: `run-${read.status === "unavailable" ? read.code : read.status}` };
  if (!TERMINAL_STATES.has(read.run.state)) return { eligible: false, reason: "not-terminal" };
  const ageMs = clock.now().getTime() - Date.parse(read.run.updatedAt);
  if (!Number.isFinite(ageMs) || ageMs < PREPARATION_RETENTION_FLOOR_MS) return { eligible: false, reason: "retention-floor" };
  if (read.run.handoff !== undefined) {
    const manifest = await readOperationManifest(root, binding.workspaceId, assertBundleId(read.run.handoff.bundleId));
    if (manifest.status !== "ok") return { eligible: false, reason: "handoff-bundle-unavailable" };
  }
  return { eligible: true, reason: "eligible" };
}

/** Typed fail-closed refusal naming why a prune could not proceed. */
export class PreparationPruneError extends Error {
  constructor(readonly code: "not-eligible" | "key-unavailable", readonly reason: string) {
    super(`preparation prune refused: ${reason}`);
    this.name = "PreparationPruneError";
  }
}

/**
 * What one prune acts on. TWO SHAPES, because a prune that crashed has already
 * destroyed the record the other shape is built from.
 *
 * `run` is the ordinary start: a resolved, authenticated binding whose
 * eligibility is measured against the retention floor and the bundle reference
 * check. `unfinished` is the RESUME, and it exists because this operation
 * deletes the run leaf and then the manifest — measured, not assumed: after a
 * crash between staging and completion the run reads `absent`, so no binding can
 * be resolved for it, while its unit stays pending and refuses every other
 * mutation in the project. A resume path that demanded a binding could therefore
 * never run, and the pending unit would wedge the project permanently. That is
 * the guard-that-strands class, and this shape is what keeps it out.
 *
 * THE RESUME IS NOT A RELAXATION OF ELIGIBILITY BUT A DIFFERENT AUTHORITY. It
 * proceeds only on POSITIVE evidence: a `prune-planned` receipt for this unit
 * that verifies under the project's current key. Absent that, it refuses —
 * absence of a readable run is never itself permission to delete.
 */
export type PruneTargetV1 =
  | { readonly kind: "run"; readonly binding: PreparationRunBinding }
  | { readonly kind: "unfinished"; readonly runId: string };

/** Explicit prune request for one retention-eligible terminal run. */
export interface PrunePreparationInput {
  /**
   * The gate decision this prune acts under. REQUIRED: the boolean it replaces
   * (`resumed`) is what let this path re-check nothing at all.
   */
  authorization: LifecycleAuthorizationV1;
  target: PruneTargetV1;
  actor: PreparationPrincipalV1;
  at: string;
  clock: LifecycleClock;
  faults?: DeleteFaultsForTest;
}

/**
 * Prune as a driver adapter.
 *
 * What is NOT here is the point: no plan/apply/verify/complete sequence, no
 * receipt writes, no deletes. Those moved to the driver-owned engine, which is
 * what PLA-INV-07 requires -- an adapter decides ELIGIBILITY and the object SET
 * and nothing about protocol.
 */
const pruneAdapter: LifecycleCustodyAdapter<PrunePreparationInput, "verified-delete"> = {
  operation: "prune",
  planKind: "verified-delete",

  async assess(root, input, read) {
    const key = await readPreparationKey(root);
    if (key.status !== "ok") {
      throw new PreparationPruneError("key-unavailable", `key-${key.status}`);
    }
    // ONE DERIVATION OF THE UNIT ID, from the run id alone, for both shapes —
    // and the same pure function the service calls to build the gate's ticket.
    // Check and executor share the primitive rather than each deriving one.
    const runId = input.target.kind === "run" ? input.target.binding.runId : input.target.runId;
    const unitId = pruneUnitIdFor(runId);
    const started = await pruneUnitStarted(root, unitId, key.key, "prune");
    if (input.target.kind === "unfinished") {
      // POSITIVE EVIDENCE ONLY. A resume is authorized by a signed plan that
      // verifies under the current key, never by the run being unreadable.
      //
      // A BACKSTOP THE GATE PRE-EMPTS, and that is measured rather than assumed:
      // a prune unit that has lost its planned receipt classifies with
      // `operation: null`, so the gate's owner rule refuses it as escalate-only
      // and no ticket is ever issued for it. This line is therefore UNREACHABLE
      // through the service today and is deliberately not cited as a control —
      // it exists so that a second caller of this entry point cannot resume on
      // an unauthenticated plan, and it is uncovered for exactly that reason.
      if (!started) throw new PreparationPruneError("not-eligible", "no-signed-plan-to-resume");
      // NO OBJECT ENUMERATION. The engine reuses the SIGNED plan whenever one
      // exists, so a freshly enumerated set is discarded; enumerating one here
      // would be a second observation with no consumer.
      return {
        draft: { kind: "verified-delete" as const, unitId, operation: "prune" as const, runId, objects: [] },
        key: { key: key.key, keyEpochId: key.keyEpochId },
      };
    }
    const eligibility = await pruneEligibility(root, input.target.binding, input.clock);
    // The eligibility waiver on resume, preserved exactly: a unit with a signed
    // plan continues on that plan's authority even once it would no longer be
    // eligible, because the plan is the authority and abandoning a started delete
    // strands staged bytes. Recorded as a known relaxation in PLA-MAP-PRN03.
    if (!eligibility.eligible && !started) {
      throw new PreparationPruneError("not-eligible", eligibility.reason);
    }
    return {
      draft: {
        kind: "verified-delete" as const,
        unitId,
        operation: "prune" as const,
        runId,
        objects: await enumerateRunScope(root, input.target.binding, read),
      },
      key: { key: key.key, keyEpochId: key.keyEpochId },
    };
  },

  // Nothing to materialize: prune governs under the key that already exists.
  materialize: async (_root, _input, assessment) => assessment.key as LifecycleGoverningKey,
};

/**
 * Capture prune's authority at the PUBLIC boundary, before the first await.
 *
 * The driver's seal SPREADS the request, so nested authority stays aliased to the
 * caller's objects -- and prune's adapter reads `binding` and `clock` after awaits,
 * inside the read lease. External review reproduced both consequences, and for a
 * delete the first is the worst one available:
 *
 *   - mutating `binding` in place RETARGETED the deletion: a different run's bytes
 *     were destroyed while the named run survived;
 *   - mutating `clock.now` in place turned a retention-floor refusal into a
 *     successful deletion.
 *
 * Quarantine and reset each grew this helper after review found the same window;
 * Task 9E routed prune through the same driver and did not give it one. Prune was
 * the missing sibling.
 *
 * The CLOCK IS SAMPLED ONCE, AS A PRIMITIVE. Two weaker versions of this were
 * wrong, both caught by review:
 *
 *   - retaining the caller's clock object and freezing the wrapper does nothing,
 *     because `now` is a method the caller can replace;
 *   - sampling `now()` and storing the DATE is also mutable -- `Object.freeze`
 *     does not freeze a Date's internal timestamp, so `setTime` on the caller's
 *     retained Date moved the sampled instant and turned a retention-floor
 *     refusal into a completed deletion.
 *
 * Milliseconds have nothing left to mutate. A frozen wrapper around mutable state
 * is not a capture.
 */
function capturePruneInput(input: PrunePreparationInput): PrunePreparationInput {
  const instantMs = input.clock.now().getTime();
  return Object.freeze({
    authorization: input.authorization,
    target: capturePruneTarget(input.target),
    actor: Object.freeze({ id: input.actor.id, surface: input.actor.surface }),
    at: input.at,
    clock: Object.freeze({ now: () => new Date(instantMs) }),
    ...(input.faults === undefined ? {} : { faults: input.faults }),
  });
}

/**
 * Copy the target field by field, per shape.
 *
 * FIELD BY FIELD RATHER THAN SPREAD, for the same reason the binding always was:
 * a spread copies whatever the caller's object carries at the instant it runs
 * and shares every nested reference, which is exactly how a mutation of
 * `binding` in place retargeted a deletion. A `kind` read from the caller's
 * object twice could also select one branch here and another later.
 */
function capturePruneTarget(target: PruneTargetV1): PruneTargetV1 {
  if (target.kind === "unfinished") {
    return Object.freeze({ kind: "unfinished" as const, runId: target.runId });
  }
  return Object.freeze({
    kind: "run" as const,
    binding: Object.freeze({
      runId: target.binding.runId,
      preparationId: target.binding.preparationId,
      manifestDigest: target.binding.manifestDigest,
      workspaceId: target.binding.workspaceId,
      keyEpochId: target.binding.keyEpochId,
    }),
  });
}

/** Prune one eligible terminal run's exact bytes via the crash-safe two-phase delete. */
export async function prunePreparationRunLocked(
  root: string, input: PrunePreparationInput,
): Promise<PruneReceiptV1> {
  return runLifecycleCustodyOperation(root, pruneAdapter, capturePruneInput(input));
}

/** Explicit orphan-sweep request over provably-absent-owner preparation bytes. */
export interface SweepPreparationInput {
  actor: PreparationPrincipalV1;
  at: string;
  /**
   * The gate decision this sweep acts under.
   *
   * REPLACES `expectedUnitId`, and the replacement is the point. That field
   * carried only the sweep unit the gate resolved, so the executor's re-check
   * compared a strict SUBSET of what the gate decided — newly visible
   * quarantine or reset state moved nothing it looked at. Carrying the whole
   * decision lets the driver re-run the gate's own predicate instead.
   */
  authorization: LifecycleAuthorizationV1;
  faults?: DeleteFaultsForTest;
}

/**
 * Private sentinel: assess found nothing to sweep.
 *
 * The decision "is there an operation at all" has to happen INSIDE the driver's
 * capture, or sweep needs a second snapshot to make it -- which is what it had.
 * Throwing a module-private marker lets the public wrapper answer `null` without
 * the driver minting a permit or creating an empty unit, and without a new driver
 * abstraction for a case only sweep has.
 */
class NothingToSweep extends Error {}

/**
 * Private sentinel: the key could not be read, so owners cannot be classified.
 *
 * Distinct from `NothingToSweep` because they are different facts -- "nothing to
 * do" and "cannot tell what to do" -- even though both fail closed to the same
 * `null`. Collapsing them would be one value for two reasons, which this package
 * has been bitten by often enough to keep them apart.
 */
class SweepKeyUnavailable extends Error {}

/**
 * Refusal when the capture resolves a different unit than the gate authorized.
 *
 * NOT a private sentinel that collapses to a benign answer, unlike the two
 * above. "Nothing to do" and "cannot tell what to do" are states of the project;
 * this is a state of the SYSTEM — the check and the executor disagreed — and a
 * destructive operation that discovers that must be loud rather than tidy.
 */
/**
 * Refusal when this capture cannot trust what it is looking at.
 *
 * TYPED BECAUSE IT REACHES AN OPERATOR. These were bare `Error`s, and a bare
 * error out of a service operation escapes as a THROW — measured through the
 * binary, `preparation sweep --json` exited 1 with EMPTY STDOUT, so a consumer
 * asking for an envelope got nothing to parse. `prune` has no such leak on the
 * same fault only because its run lookup refuses one leg earlier, which makes
 * this a sweep-only asymmetry rather than a shared limitation, and three
 * comments in this change assert the opposite.
 */
export class SweepUnobservableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "SweepUnobservableError";
  }
}

/** Sweep as a driver adapter, sharing the engine, permit, lease and in-flight guard. */
const sweepAdapter: LifecycleCustodyAdapter<SweepPreparationInput, "verified-delete"> = {
  operation: "sweep",
  planKind: "verified-delete",

  /**
   * ONE capture, the driver's. Everything sweep decides -- which pending unit to
   * resume, and failing that which orphans to collect -- is derived from `read`.
   *
   * It took THREE snapshots before this: one to find the pending unit, one to
   * enumerate orphans, and the driver's own, which this callback ignored
   * entirely. Two of those were mine, and the second was added by the change that
   * removed sibling enumeration -- trading an uncaptured walk for an extra
   * capture is not what PLA-INV-03 asks for.
   */
  async assess(root, input, read) {
    if (read.status === "unavailable") {
      throw new Error("prune registry cannot be enumerated");
    }
    // THE SUBSET COMPARISON IS GONE, AND SO IS ITS REPLACEMENT HERE. It
    // compared only the sweep unit id, so a pending quarantine or reset unit
    // appearing after the gate authorized moved nothing it looked at and it
    // passed. The driver now re-runs the GATE'S OWN predicate over this same
    // capture before any adapter is asked to assess, which subsumes this
    // comparison and every arm the gate applies.
    //
    // MEASURED, NOT ASSUMED, because "looks subsumed" is the class of claim this
    // surface keeps falsifying. With the driver's re-evaluation neutered both
    // divergence cases went GREEN here -- so this was a working control, not
    // dead for some other reason -- and with it restored they refuse one layer
    // earlier through the gate's own predicate. Two derivations of one quantity
    // from one snapshot is the agreeing-by-coincidence shape; keeping the
    // narrower one leaves a second projection to drift against the first.
    //
    // THE PROJECTION ITSELF STAYS: it is what the plan is built from below --
    // a resume targets the pending unit, a fresh sweep enumerates orphans. Only
    // the COMPARISON was removed, not the observation.
    const pending = pendingSweepUnitOf(read.snapshot);
    // The key read moved HERE from the public entry. Awaiting it before invoking
    // the driver put a mutation window in front of the driver's synchronous seal,
    // and review reproduced the consequence: mutate `actor.id` right after the
    // call and the signed receipt attests the mutated identity. Quarantine, reset
    // and prune each closed this window already; sweep was the fourth sibling.
    const key = await readPreparationKey(root);
    if (key.status !== "ok") throw new SweepKeyUnavailable();
    const governing: LifecycleGoverningKey = { key: key.key, keyEpochId: key.keyEpochId };
    const objects = pending === null
      ? await enumerateSweepableOrphans(
          root, governing.keyEpochId as PreparationRunBinding["keyEpochId"], read)
      : [];
    if (pending === null && objects.length === 0) throw new NothingToSweep();
    return {
      draft: {
        kind: "verified-delete" as const,
        unitId: pending ?? sweepUnitIdFor(objects),
        operation: "sweep" as const,
        objects,
      },
      key: governing,
    };
  },

  // Nothing to materialize: sweep governs under the key `assess` already read.
  materialize: async (_root, _input, assessment) => assessment.key as LifecycleGoverningKey,
};

/**
 * The closed outcome of one sweep. THREE ANSWERS, not one nullable receipt.
 *
 * `nothing-to-sweep` and `key-unavailable` used to be two module-private
 * sentinels that both fail-closed to `null`, and the file said plainly they were
 * different facts — "nothing to do" and "cannot tell what to do" — while handing
 * every caller one value for both. That is the park-vs-deny distinction D-10-4
 * requires at each read leg, collapsed one layer below the surface that has to
 * report it: an operator told "nothing to reclaim" about a project whose key
 * could not be read has been told something false.
 */
export type SweepOutcomeV1 =
  | { readonly status: "swept"; readonly receipt: PruneReceiptV1 }
  | { readonly status: "nothing-to-sweep" }
  | { readonly status: "key-unavailable" };

/**
 * Sweep every inert orphan whose run leaf is provably absent (never unreadable).
 *
 * An UNFINISHED sweep is resumed before any new one is derived: the unit id is a
 * digest of the visible object paths, so once the first object is staged it leaves
 * the inventory and the next pass would derive a DIFFERENT id, stranding the
 * original unit with staged bytes and no completed receipt. Which unfinished
 * sweep — if any — this call may resume is decided by the GATE that acquired the
 * lock and carried on `input.expectedUnitId`; this function proves its own
 * capture agrees rather than deciding again.
 */
export async function sweepPreparationOrphansLocked(
  root: string, input: SweepPreparationInput,
): Promise<SweepOutcomeV1> {
  // NO AWAIT BEFORE THIS CALL. The driver seals the request synchronously on
  // entry; anything awaited first is a window the seal cannot cover.
  try {
    return { status: "swept", receipt: await runLifecycleCustodyOperation(root, sweepAdapter, input) };
  } catch (error) {
    // Still fail-closed — neither writes anything — but no longer indistinguishable.
    if (error instanceof NothingToSweep) return { status: "nothing-to-sweep" };
    if (error instanceof SweepKeyUnavailable) return { status: "key-unavailable" };
    throw error;
  }
}

/**
 * Resolve the one sweepable prune unit from a single captured snapshot.
 *
 * THE SELECTION RULE ITSELF IS NOT HERE. It moved to the shared selector so the
 * gate that authorizes a sweep and this executor read one primitive; what
 * remains is the registry HEALTH check, which is this capture's own fail-closed
 * obligation and has no analogue at the gate.
 */
function pendingSweepUnitOf(snapshot: PreparationLifecycleSnapshotV1): string | null {
  const registry = projectPruneRegistryHealth(snapshot);
  if (registry.status === "unavailable") throw new SweepUnobservableError(registry.detail);
  const selected = selectSweepTargetUnit(projectPendingUnits(snapshot));
  if (selected.status === "blocked") throw new SweepUnobservableError(selected.detail);
  return selected.unitId;
}

/** Collect the leaves of every preparation whose manifest reads but whose run is absent. */
async function enumerateSweepableOrphans(
  root: string,
  keyEpochId: PreparationRunBinding["keyEpochId"],
  read: PreparationLifecycleReadV1 & { status: "ok" },
): Promise<ScopedQuarantineObject[]> {
  // The CALLER'S capture, not one of its own. Safe to plan from because a
  // destructive plan's object set provably never reaches the quarantine registry
  // -- pinned by `destructive-object-scope.test.ts`.
  const scan = await scanForDestructivePlan(root, read);
  const objects: ScopedQuarantineObject[] = [];
  for (const directory of scan.preparationDirectories) {
    const manifest = await readPreparationManifest(root, directory.workspaceId, directory.preparationId as PreparationRunBinding["preparationId"]);
    if (manifest.status !== "ok") continue; // unreadable owner is unavailable, never absent
    const run = await readPreparationRun(root, {
      runId: manifest.manifest.runId, preparationId: manifest.manifest.preparationId, workspaceId: manifest.manifest.workspaceId,
      manifestDigest: preparationManifestDigest(manifest.manifest), keyEpochId,
    });
    if (run.status !== "absent") continue; // only a provably absent run is an orphan
    for (const leaf of scan.leaves.filter((entry) => entry.workspaceId === directory.workspaceId && entry.preparationId === directory.preparationId)) {
      objects.push(await scopedLeafObject(root, leaf.relativePath, leaf.bytes));
    }
  }
  return objects;
}

/** Whether a prune/sweep unit already has a signed planned receipt (a resume). */
async function pruneUnitStarted(root: string, unitId: string, key: Buffer, operation: PruneReceiptContentV1["operation"]): Promise<boolean> {
  await assertConfinedPruneUnit(root, unitId);
  return (await readVerifiedPruneReceipt(
    root,
    unitId,
    key,
    "prune-planned",
    operation,
  )) !== null;
}

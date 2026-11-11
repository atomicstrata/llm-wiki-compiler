/**
 * @file src/preparations/lifecycle-snapshot/scan.ts
 * @description Public Task 9B scanner: capture one bound key observation,
 * enumerate both registries once, classify in two passes, revalidate every
 * authority identity, erase key bytes, and publish one immutable digest.
 *
 * ONE BODY, {@link scanPreparationLifecycleFrom}, over {@link LifecycleScanReads}:
 * the namespace and key re-proofs, the key capture, the registry observation, the
 * per-unit identity re-proof, the storage revalidation, and the classifiers' leaf
 * reads. All are confined MECHANISM reads, and none takes a project root; every
 * decision (pass one and two, races, ordering, completeness, digest, key erasure)
 * is in the body. {@link scanPreparationLifecycle} keeps its signature and its brand
 * check, and passes the namespace's disk reads.
 *
 * AUTHORITY IS UNCHANGED. The body is exported for its witness only and is in no
 * package index. A snapshot it returns is NOT a recorded lifecycle read:
 * `read.ts` records only the reads it mints itself around the root form, so a
 * caller that supplies its own reads cannot forge a successful lifecycle read.
 */

import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import {
  assertPreparationLifecycleNamespaceCurrent,
  assertPreparationLifecycleNamespaceBrand,
} from "../lifecycle-fs/namespace.js";
import {
  lifecycleRelativePath,
  observeLifecycleRegistries,
  type LifecycleUnitObservation,
} from "../lifecycle-fs/observe.js";
import {
  lifecycleUnitStillCurrent,
  revalidateLifecycleStorage,
} from "../lifecycle-fs/revalidate.js";
import type { LifecycleObservationSet, PreparationLifecycleNamespaceV1 } from "../lifecycle-fs/types.js";
import { lifecycleScanBounds, type LifecycleScanBounds } from "../lifecycle-fs/bounds.js";
import { diskLifecycleLeafReads, type LifecycleLeafReads, type LifecyclePassOneUnit } from "./classifier-types.js";
import { classifyPrunePassOneFrom } from "./prune-classifier.js";
import { classifyQuarantinePassOneFrom } from "./quarantine-classifier.js";
import {
  assertLifecycleKeyObservationCurrent,
  captureLifecycleKey,
  type CapturedLifecycleKey,
} from "../lifecycle-fs/key-observation.js";
import { projectPreparationLifecycleStorage } from "./storage.js";
import type {
  PreparationLifecycleProblemV1,
  PreparationLifecycleScanOptionsV1,
  PreparationLifecycleSnapshotV1,
  PreparationLifecycleUnitV1,
} from "./types.js";

/** The confined reads one scan makes, each bound to one namespace. No member takes a project root. */
export interface LifecycleScanReads {
  /**
   * Re-prove the namespace's root, private root, registries and key binding; THROWS
   * on drift. `"reproved-after"` leaves the key binding to the key observation's
   * re-proof that immediately follows.
   */
  assertNamespaceCurrent(keyBinding?: "recheck" | "reproved-after"): Promise<void>;
  /** Capture the bound key observation once. */
  captureKey(): Promise<CapturedLifecycleKey>;
  /** Enumerate both registries once within `bounds`. */
  observeRegistries(bounds: LifecycleScanBounds, onEnumerated?: (registry: "quarantine" | "prune") => void): Promise<LifecycleObservationSet>;
  /** Whether one observed unit's identity still holds. */
  unitStillCurrent(observation: LifecycleUnitObservation): Promise<boolean>;
  /** Re-observe the registries' storage against the first observation. */
  revalidateStorage(storage: LifecycleObservationSet["storage"]): ReturnType<typeof revalidateLifecycleStorage>;
  /** Re-prove the captured key observation; THROWS on drift. */
  assertKeyCurrent(key: CapturedLifecycleKey): Promise<void>;
  /** The classifiers' leaf reads. */
  readonly leaves: LifecycleLeafReads;
}

/** LOCAL DISK. The confined incumbents for `namespace`, each called when asked. Exported for the scan witness only; in no package index. */
export function diskLifecycleScanReads(namespace: PreparationLifecycleNamespaceV1): LifecycleScanReads {
  return {
    assertNamespaceCurrent: (keyBinding) => assertPreparationLifecycleNamespaceCurrent(namespace, keyBinding),
    captureKey: () => captureLifecycleKey(namespace),
    observeRegistries: (bounds, onEnumerated) => observeLifecycleRegistries(namespace, bounds, onEnumerated),
    unitStillCurrent: (observation) => lifecycleUnitStillCurrent(observation),
    revalidateStorage: (storage) => revalidateLifecycleStorage(namespace, storage),
    assertKeyCurrent: (key) => assertLifecycleKeyObservationCurrent(namespace, key),
    leaves: diskLifecycleLeafReads(namespace),
  };
}

/** Recursively freeze the plain snapshot graph before it leaves the scanner. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

/** Classify one observed unit through its physical registry's sole classifier. */
async function classifyPassOne(
  leaves: LifecycleLeafReads,
  namespace: PreparationLifecycleNamespaceV1,
  observation: LifecycleUnitObservation,
  key: Awaited<ReturnType<typeof captureLifecycleKey>>,
  bounds: ReturnType<typeof lifecycleScanBounds>,
): Promise<LifecyclePassOneUnit> {
  return observation.registry === "quarantine"
    ? classifyQuarantinePassOneFrom(leaves, { namespace, observation, key, bounds })
    : classifyPrunePassOneFrom(leaves, namespace, observation, key, bounds);
}

/** Build the active-key retirement map, rejecting contradictory attestations. */
function retirementMap(
  passOne: readonly LifecyclePassOneUnit[],
): { values: ReadonlyMap<string, string>; conflicts: ReadonlySet<string> } {
  const values = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const result of passOne) {
    for (const entry of result.retirementEvidence) {
      const current = values.get(entry.unitId);
      if (current !== undefined && current !== entry.receiptDigest) {
        conflicts.add(entry.unitId);
      } else {
        values.set(entry.unitId, entry.receiptDigest);
      }
    }
  }
  return { values, conflicts };
}

/** Resolve exact old-receipt retirement evidence without re-enumerating. */
function passTwoUnits(
  passOne: readonly LifecyclePassOneUnit[],
): { units: PreparationLifecycleUnitV1[]; problems: PreparationLifecycleProblemV1[] } {
  const retirement = retirementMap(passOne);
  const units: PreparationLifecycleUnitV1[] = [];
  const problems: PreparationLifecycleProblemV1[] = [];
  for (const result of passOne) {
    const digest = result.historicalCandidateDigest;
    const expected = retirement.values.get(result.unit.unitId);
    const historical = digest !== undefined &&
      expected === digest &&
      !retirement.conflicts.has(result.unit.unitId);
    if (historical) {
      units.push({
        ...result.unit,
        operation: result.historicalCandidateOperation ?? "per-run-quarantine",
        state: "historical",
      });
      continue;
    }
    units.push(result.unit);
    if (result.problem !== undefined) problems.push(result.problem);
  }
  return { units, problems };
}

/** Replace a raced unit classification with one explicit unavailable result. */
function racedUnit(
  namespace: PreparationLifecycleNamespaceV1,
  observation: LifecycleUnitObservation,
): LifecyclePassOneUnit {
  const problem = observation.problem ?? {
    code: "unit-unavailable" as const,
    registry: observation.registry,
    unitId: observation.unitId,
    path: lifecycleRelativePath(namespace.root.realPath, observation.unitRoot),
    detail: "unit identity changed during lifecycle observation",
  };
  return {
    unit: {
      registry: observation.registry,
      unitId: observation.unitId,
      operation: null,
      state: "unavailable",
    },
    problem,
    retirementEvidence: [],
  };
}

/** Classify and then re-prove each unit identity before accepting its result. */
async function classifyAll(
  reads: LifecycleScanReads,
  namespace: PreparationLifecycleNamespaceV1,
  observations: readonly LifecycleUnitObservation[],
  key: Awaited<ReturnType<typeof captureLifecycleKey>>,
  bounds: ReturnType<typeof lifecycleScanBounds>,
  afterClassification?: () => Promise<void>,
): Promise<LifecyclePassOneUnit[]> {
  const results: LifecyclePassOneUnit[] = [];
  for (const observation of observations) {
    results.push(await classifyPassOne(reads.leaves, namespace, observation, key, bounds));
  }
  await afterClassification?.();
  for (const [index, observation] of observations.entries()) {
    if (!(await reads.unitStillCurrent(observation))) {
      results[index] = racedUnit(namespace, observation);
    }
  }
  return results;
}

/** Canonical digest over every public snapshot fact except the digest itself. */
function snapshotDigest(
  snapshot: Omit<PreparationLifecycleSnapshotV1, "digest">,
): string {
  return canonicalDigest({
    domain: "llmwiki.preparation-lifecycle.snapshot.v1",
    ...snapshot,
  });
}

/**
 * Assemble one snapshot's content. Extracted so `scanPreparationLifecycle` stays
 * inside the 40-line function ceiling — it crossed it in this task, and the only
 * function-size control in the repository policed a different function.
 */
function snapshotContent(
  namespace: PreparationLifecycleNamespaceV1,
  key: Awaited<ReturnType<typeof captureLifecycleKey>>,
  units: PreparationLifecycleSnapshotV1["units"],
  problems: PreparationLifecycleSnapshotV1["problems"],
  currentStorage: Awaited<ReturnType<typeof revalidateLifecycleStorage>>,
) {
  const storage = projectPreparationLifecycleStorage(currentStorage);
  return {
    namespaceDigest: namespace.digest,
    keyState: key.status === "ok"
      ? { status: "ok" as const, keyEpochId: key.keyEpochId }
      : { status: key.status },
    units,
    storage,
    // Each conjunct is load-bearing. Both storage terms are isolated in
    // test/preparations/lifecycle-quarantine-key-guard.test.ts by a
    // post-classification size change on the matching registry's receipt. The
    // problems term is not isolated and cannot be: every fault that raises a
    // problem also sets a health field. Adding a fourth conjunct makes those
    // tests' "sole reason" comments imprecise — update both.
    complete: problems.length === 0 &&
      storage.quarantine.health === "ok" &&
      storage.prune.health === "ok",
    problems,
  };
}

/**
 * Observe both lifecycle registries under one root-bound authority. The caller
 * cannot supply key state, registry paths, receipt paths, or classifier hooks.
 */
export async function scanPreparationLifecycle(
  namespace: PreparationLifecycleNamespaceV1,
  options: PreparationLifecycleScanOptionsV1 = {},
): Promise<PreparationLifecycleSnapshotV1> {
  assertPreparationLifecycleNamespaceBrand(namespace);
  return scanPreparationLifecycleFrom(diskLifecycleScanReads(namespace), namespace, options);
}

/**
 * {@link scanPreparationLifecycle} for a namespace its caller opened IMMEDIATELY
 * before, with no await in between. The opener's own final revalidation is then
 * the scan's start proof, so the body does not repeat it; the end proof, the key
 * identity checks and the registries' own identity checks are all unchanged.
 * Used only by `read.ts`, which opens and scans back to back. In no package index.
 */
export async function scanJustOpenedPreparationLifecycle(
  namespace: PreparationLifecycleNamespaceV1,
  options: PreparationLifecycleScanOptionsV1 = {},
  keyObservation: LifecycleKeyObservation = "always",
): Promise<PreparationLifecycleSnapshotV1> {
  assertPreparationLifecycleNamespaceBrand(namespace);
  return scanPreparationLifecycleFrom(
    diskLifecycleScanReads(namespace), namespace, options, "proven-by-open", keyObservation,
  );
}

/**
 * When a scan reads the key. `"always"` is every caller's default: the snapshot
 * carries the key state. `"for-units"` reads it only when a registry is bound
 * present, because a unit's receipts are the only thing in a scan the key
 * authenticates; with both registries proved absent there is nothing for it to
 * authenticate, and the snapshot reports the key `unobserved`. Only the
 * recovery gate's pass asks for it (`read.ts`), and that pass's consumers read
 * pending units and quarantine storage, never the key state; a consumer that
 * does need the key refuses any state but `ok`.
 */
export type LifecycleKeyObservation = "always" | "for-units";

/** Whether the namespace bound both registries ABSENT, so the scan has no unit to observe. */
function registriesProvedAbsent(namespace: PreparationLifecycleNamespaceV1): boolean {
  return namespace.quarantineRegistry.status === "absent" && namespace.pruneRegistry.status === "absent";
}

/** The key observation one scan makes: none when nothing it could authenticate exists. */
async function observeKey(
  reads: LifecycleScanReads, namespace: PreparationLifecycleNamespaceV1, keyObservation: LifecycleKeyObservation,
): Promise<CapturedLifecycleKey> {
  if (keyObservation === "for-units" && registriesProvedAbsent(namespace)) return { status: "unobserved" };
  return reads.captureKey();
}

/**
 * The scan's END PROOF: the namespace and the key re-proven after everything
 * the scan read.
 *
 * NOTHING TO BRACKET, NOTHING RE-PROVEN. When the start proof bound both
 * registries absent and the key was not read (absent at the start proof, or
 * not observed), the scan read nothing after its start proof: no registry was
 * enumerated, no unit classified, no key leaf opened. The snapshot is then
 * exactly the facts the start proof established at one instant, and a second
 * revalidation could only re-establish them at a later one. A registry or key
 * appearing after the start proof is outside the snapshot either way, as it is
 * when it appears after the end proof.
 */
async function proveScanEnd(
  reads: LifecycleScanReads, namespace: PreparationLifecycleNamespaceV1, key: CapturedLifecycleKey,
): Promise<void> {
  const keyRead = key.status === "ok" || key.status === "unavailable";
  if (!keyRead && registriesProvedAbsent(namespace)) return;
  // An ok key observation is re-proven next against the namespace's own key
  // binding, which proves every fact the namespace's key check would; an absent
  // or unavailable one opens nothing there, so the namespace checks the leaf.
  await reads.assertNamespaceCurrent(key.status === "ok" ? "reproved-after" : "recheck");
  if (key.status !== "unobserved") await reads.assertKeyCurrent(key);
}

/**
 * {@link scanPreparationLifecycle} over {@link LifecycleScanReads}: THE ONE BODY.
 * Exported for its witness only; in no package index, and its snapshots are never
 * recorded lifecycle reads.
 *
 * THE START PROOF is the namespace revalidation before the key capture. It is
 * skipped only for `proven-by-open`, where the opener revalidated the same
 * namespace with nothing in between. Registry observation does NOT repeat it:
 * the key capture between them is identity-checked against the namespace, and
 * each registry enumeration proves its own registry's dev/ino.
 */
export async function scanPreparationLifecycleFrom(
  reads: LifecycleScanReads,
  namespace: PreparationLifecycleNamespaceV1,
  options: PreparationLifecycleScanOptionsV1 = {},
  startProof: "revalidate" | "proven-by-open" = "revalidate",
  keyObservation: LifecycleKeyObservation = "always",
): Promise<PreparationLifecycleSnapshotV1> {
  if (startProof === "revalidate") await reads.assertNamespaceCurrent();
  const key = await observeKey(reads, namespace, keyObservation);
  try {
    await options.afterKeyCapturedForTest?.();
    const bounds = lifecycleScanBounds(options);
    const observed = await reads.observeRegistries(bounds, options.onRegistryEnumeratedForTest);
    const passOne = await classifyAll(
      reads, namespace, observed.units, key, bounds, options.afterClassificationForTest,
    );
    const currentStorage = await reads.revalidateStorage(observed.storage);
    await proveScanEnd(reads, namespace, key);
    const projected = passTwoUnits(passOne);
    const registryProblems = observed.problems.filter((problem) => problem.unitId === undefined);
    const problems = [...registryProblems, ...projected.problems]
      .sort((left, right) => `${left.registry}:${left.unitId ?? ""}:${left.path}:${left.code}`
        .localeCompare(`${right.registry}:${right.unitId ?? ""}:${right.path}:${right.code}`));
    const units = projected.units.sort((left, right) =>
      `${left.registry}:${left.unitId}`.localeCompare(`${right.registry}:${right.unitId}`));
    const content = snapshotContent(namespace, key, units, problems, currentStorage);
    return deepFreeze({ ...content, digest: snapshotDigest(content) });
  } finally {
    if (key.status === "ok") key.key.fill(0);
  }
}

export type {
  PreparationLifecycleScanOptionsV1,
  PreparationLifecycleSnapshotV1,
} from "./types.js";

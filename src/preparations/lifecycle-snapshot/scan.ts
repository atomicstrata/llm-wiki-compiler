/**
 * @file src/preparations/lifecycle-snapshot/scan.ts
 * @description Public Task 9B scanner: capture one bound key observation,
 * enumerate both registries once, classify in two passes, revalidate every
 * authority identity, erase key bytes, and publish one immutable digest.
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
import type { PreparationLifecycleNamespaceV1 } from "../lifecycle-fs/types.js";
import { lifecycleScanBounds } from "../lifecycle-fs/bounds.js";
import type { LifecyclePassOneUnit } from "./classifier-types.js";
import { classifyPrunePassOne } from "./prune-classifier.js";
import { classifyQuarantinePassOne } from "./quarantine-classifier.js";
import {
  assertLifecycleKeyObservationCurrent,
  captureLifecycleKey,
} from "../lifecycle-fs/key-observation.js";
import { projectPreparationLifecycleStorage } from "./storage.js";
import type {
  PreparationLifecycleProblemV1,
  PreparationLifecycleScanOptionsV1,
  PreparationLifecycleSnapshotV1,
  PreparationLifecycleUnitV1,
} from "./types.js";

/** Recursively freeze the plain snapshot graph before it leaves the scanner. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

/** Classify one observed unit through its physical registry's sole classifier. */
async function classifyPassOne(
  namespace: PreparationLifecycleNamespaceV1,
  observation: LifecycleUnitObservation,
  key: Awaited<ReturnType<typeof captureLifecycleKey>>,
  bounds: ReturnType<typeof lifecycleScanBounds>,
): Promise<LifecyclePassOneUnit> {
  return observation.registry === "quarantine"
    ? classifyQuarantinePassOne({ namespace, observation, key, bounds })
    : classifyPrunePassOne(namespace, observation, key, bounds);
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
  namespace: PreparationLifecycleNamespaceV1,
  observations: readonly LifecycleUnitObservation[],
  key: Awaited<ReturnType<typeof captureLifecycleKey>>,
  bounds: ReturnType<typeof lifecycleScanBounds>,
  afterClassification?: () => Promise<void>,
): Promise<LifecyclePassOneUnit[]> {
  const results: LifecyclePassOneUnit[] = [];
  for (const observation of observations) {
    results.push(await classifyPassOne(namespace, observation, key, bounds));
  }
  await afterClassification?.();
  for (const [index, observation] of observations.entries()) {
    if (!(await lifecycleUnitStillCurrent(observation))) {
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
  await assertPreparationLifecycleNamespaceCurrent(namespace);
  const key = await captureLifecycleKey(namespace);
  try {
    await options.afterKeyCapturedForTest?.();
    const bounds = lifecycleScanBounds(options);
    const observed = await observeLifecycleRegistries(
      namespace, bounds, options.onRegistryEnumeratedForTest,
    );
    const passOne = await classifyAll(
      namespace, observed.units, key, bounds, options.afterClassificationForTest,
    );
    const currentStorage = await revalidateLifecycleStorage(namespace, observed.storage);
    await assertPreparationLifecycleNamespaceCurrent(namespace);
    await assertLifecycleKeyObservationCurrent(namespace, key);
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

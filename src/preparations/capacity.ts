/**
 * @file src/preparations/capacity.ts
 * @description Complete read-only preparation inventory and named launch-cap
 * arithmetic (design sections 8.4, 26.1, 26.2). Unavailable ACTIVE or QUARANTINE
 * state poisons health and blocks staging. An unavailable prune fault —
 * whether inside a real prune registry or AT its canonical path, where read-mode
 * binding now degrades rather than rejecting the capture — deliberately does not
 * gate capacity; it poisons snapshot health for the reference/GC and
 * recovery-gate consumers instead. Readable lifecycle content whose semantic
 * role is unknown does not gate either (design V3 section 3.3). Manifest, run,
 * cancel, evidence, and orphan bytes are never skipped. Active storage is scanned
 * independently from the destructive compatibility traversal, while quarantine
 * capacity is projected from one callback-scoped lifecycle read. Active bytes
 * count every nonterminal, retained-terminal, orphan, recovery-required, and
 * integrity-invalid leaf. The prepared-inputs dimension is accounted against its
 * own ceiling.
 */

import path from "node:path";
import { authoritativeManifests, hasAuthoritativeRun, capacityViolation, uniqueInventoryBytes as uniqueBytes } from "../utils/inventory-arithmetic.js";
import {
  MAX_ACTIVE_NONTERMINAL_RUNS, MAX_ACTIVE_PREPARATION_BYTES,
  MAX_ACTIVE_PREPARATIONS_PER_WORKSPACE, MAX_NEW_PREPARATIONS_PER_STAGING_CALL,
  MAX_PREPARATION_EVIDENCE_OBJECT_BYTES, MAX_PREPARATION_MANIFEST_BYTES,
  MAX_PREPARATION_RUN_BYTES, MAX_PREPARED_INPUTS_PER_RUN,
} from "./constants.js";
import type { PreparationId, PreparationRunId } from "./ids.js";
import type { PreparationEpochInventory, PreparationEpochInventoryEntry } from "./key-epoch.js";
import { readPreparationKey } from "./key-epoch.js";
import { validatePreparationSupersessionSet } from "./manifest-graph.js";
import { preparationManifestDigest, type PreparationManifestV1 } from "./manifest-parse.js";
import { readPreparationManifest } from "./manifest-store.js";
import {
  preparationScanEntryLimit, scanActivePreparationStore,
  type PreparationInventoryProblem,
  type PreparationLeafObservation, type PreparationScanOptions,
} from "./orphan-scan.js";
import {
  assertPreparationLifecycleRead,
  withPreparationLifecycleRead,
  type PreparationLifecycleReadV1,
} from "./lifecycle-snapshot/read.js";
import type {
  PreparationLifecycleStorageEntryV1,
} from "./lifecycle-snapshot/types.js";
import { readPreparationRun } from "./run-store.js";
import type { PreparationRunState } from "./run-types.js";

const TERMINAL_STATES = new Set<PreparationRunState>([
  "handed-off", "succeeded", "succeeded-with-warnings", "failed", "cancelled",
  "cancelled-with-effects", "superseded", "abandoned",
]);

/** Every dimension preflight must project before the first staged write. */
export interface StageCapacityProjection {
  newPreparations: number;
  activeNonterminalRuns: number;
  workspacePreparations: number;
  preparedInputs: number;
  manifestBytes: number;
  runBytes: number;
  evidenceObjectBytes: number;
  activeBytes: number;
}

/** Typed refusal naming the cap that invalidated the complete projection. */
export class StageCapacityError extends Error {
  constructor(public readonly dimension: string) {
    super(`preparation staging exceeds the ${dimension} cap`);
    this.name = "StageCapacityError";
  }
}

/** Complete healthy or fail-closed project preparation inventory. */
export interface PreparationInventory {
  epoch: PreparationEpochInventory;
  quarantine: PreparationEpochInventoryEntry;
  activeBytes: number;
  activeNonterminalRuns: number;
  problems: readonly PreparationInventoryProblem[];
  manifests: readonly PreparationManifestV1[];
  workspacePreparations: ReadonlyMap<string, number>;
  preparationIds: ReadonlySet<PreparationId>;
  runIds: ReadonlySet<PreparationRunId>;
}

interface PreparationState {
  manifest: PreparationManifestV1;
  complete: boolean;
  nonterminal: boolean;
}

type ActivePreparationScan = Awaited<ReturnType<typeof scanActivePreparationStore>>;

interface LifecycleCapacityObservation {
  quarantine: PreparationLifecycleStorageEntryV1;
  problems: PreparationInventoryProblem[];
}

const CAP_ENTRIES: ReadonlyArray<[keyof StageCapacityProjection, number, string]> = [
  ["newPreparations", MAX_NEW_PREPARATIONS_PER_STAGING_CALL, "new-preparations"],
  ["activeNonterminalRuns", MAX_ACTIVE_NONTERMINAL_RUNS, "active-runs"],
  ["workspacePreparations", MAX_ACTIVE_PREPARATIONS_PER_WORKSPACE, "workspace-preparations"],
  ["preparedInputs", MAX_PREPARED_INPUTS_PER_RUN, "prepared-inputs"],
  ["manifestBytes", MAX_PREPARATION_MANIFEST_BYTES, "manifest"],
  ["runBytes", MAX_PREPARATION_RUN_BYTES, "run"],
  ["evidenceObjectBytes", MAX_PREPARATION_EVIDENCE_OBJECT_BYTES, "evidence"],
  ["activeBytes", MAX_ACTIVE_PREPARATION_BYTES, "active-bytes"],
];

/** Require nonnegative exact arithmetic and enforce every inclusive cap. */
export function assertStageCapacity(projection: StageCapacityProjection): void {
  const dimension = capacityViolation(projection, CAP_ENTRIES);
  if (dimension !== undefined) throw new StageCapacityError(dimension);
}

/** Count logical objects, folding `.tmp` and `.writing` into their destination. */
function logicalCount(leaves: readonly PreparationLeafObservation[]): number {
  return new Set(leaves.map((leaf) => leaf.logicalRelativePath)).size;
}

/** Return an exact entry whose health follows the complete scan. */
function entry(leaves: readonly PreparationLeafObservation[], unavailable: boolean): PreparationEpochInventoryEntry {
  return { count: logicalCount(leaves), bytes: uniqueBytes(leaves), health: unavailable ? "unavailable" : "ok" };
}

/** Read every authoritative manifest and preserve invalid/unavailable state. */
async function readManifests(
  root: string, leaves: readonly PreparationLeafObservation[], problems: PreparationInventoryProblem[],
): Promise<Map<string, PreparationManifestV1>> {
  const result = new Map<string, PreparationManifestV1>();
  for (const leaf of authoritativeManifests(leaves)) {
    if (leaf.workspaceId === undefined || leaf.preparationId === undefined) continue;
    const read = await readPreparationManifest(root, leaf.workspaceId, leaf.preparationId as PreparationId);
    if (read.status === "ok") result.set(`${leaf.workspaceId}\0${leaf.preparationId}`, read.manifest);
    else problems.push({ dimension: "manifest-state", detail: `preparation manifest is ${read.status}`, path: path.join(".llmwiki", leaf.relativePath) });
  }
  return result;
}

/** Verify one manifest's initial evidence, run leaf, and authenticated run. */
async function preparationState(
  root: string, manifest: PreparationManifestV1, leaves: readonly PreparationLeafObservation[],
  problems: PreparationInventoryProblem[],
): Promise<PreparationState> {
  const evidencePresent = manifest.initialEvidence.every((evidence) => leaves.some((leaf) =>
    leaf.kind === "evidence" && leaf.workspaceId === manifest.workspaceId && leaf.preparationId === manifest.preparationId
    && leaf.protocolAlias === undefined && path.basename(leaf.logicalRelativePath) === evidence.digest.slice("sha256:".length)));
  const runLeaf = hasAuthoritativeRun(leaves, manifest);
  if (!evidencePresent || !runLeaf) return { manifest, complete: false, nonterminal: false };
  const key = await readPreparationKey(root);
  if (key.status !== "ok") { problems.push({ dimension: "run-state", detail: `preparation key is ${key.status}` }); return { manifest, complete: false, nonterminal: false }; }
  const run = await readPreparationRun(root, {
    runId: manifest.runId, preparationId: manifest.preparationId, workspaceId: manifest.workspaceId,
    manifestDigest: preparationManifestDigest(manifest), keyEpochId: key.keyEpochId,
  });
  if (run.status !== "ok") { problems.push({ dimension: "run-state", detail: `preparation run is ${run.status}` }); return { manifest, complete: false, nonterminal: false }; }
  return { manifest, complete: true, nonterminal: !TERMINAL_STATES.has(run.run.state) };
}

/** Build exact active epoch totals from the active-only classified scan. */
function summarizeActive(
  scan: ActivePreparationScan,
  orphanLeaves: readonly PreparationLeafObservation[],
  unavailable: boolean,
) {
  const byKind = (kind: PreparationLeafObservation["kind"]) => scan.leaves.filter((leaf) => leaf.kind === kind);
  const epoch: PreparationEpochInventory = {
    manifests: entry(byKind("manifest"), unavailable), runs: entry(byKind("run"), unavailable),
    evidence: entry(byKind("evidence"), unavailable), cancelRequests: entry(byKind("cancel"), unavailable),
    orphans: { count: logicalCount(orphanLeaves), bytes: uniqueBytes(orphanLeaves), health: unavailable ? "unavailable" : "ok" },
  };
  return { epoch, activeBytes: uniqueBytes(scan.leaves) };
}

/** Compute orphan leaves for every preparation without a complete record. */
function orphanLeaves(scan: ActivePreparationScan, states: readonly PreparationState[]): PreparationLeafObservation[] {
  const complete = new Set(states.filter((item) => item.complete).map((item) => `${item.manifest.workspaceId}\0${item.manifest.preparationId}`));
  const completeRuns = new Set(states.filter((item) => item.complete).map((item) => `${item.manifest.workspaceId}\0${item.manifest.runId}`));
  return scan.leaves.filter((leaf) => {
    if (leaf.preparationId !== undefined) return !complete.has(`${leaf.workspaceId}\0${leaf.preparationId}`);
    if (leaf.runId !== undefined) return !completeRuns.has(`${leaf.workspaceId}\0${leaf.runId}`);
    return leaf.kind === "unknown";
  });
}

/** Count active durable preparations (one per existing preparation directory) per workspace. */
function workspacePreparationCounts(scan: ActivePreparationScan): Map<string, number> {
  const counts = new Map<string, number>();
  for (const directory of scan.preparationDirectories) {
    counts.set(directory.workspaceId, (counts.get(directory.workspaceId) ?? 0) + 1);
  }
  return counts;
}

/** Project physical lifecycle storage without interpreting semantic pendingness. */
async function lifecycleCapacity(
  root: string,
  read: PreparationLifecycleReadV1,
): Promise<LifecycleCapacityObservation> {
  if (read.status === "unavailable") {
    return {
      quarantine: {
        count: 0, bytes: 0, health: "unavailable", traversalEntries: 0,
      },
      problems: [{
        dimension: "lifecycle-storage",
        detail: "preparation lifecycle capture is unavailable",
      }],
    };
  }
  await assertPreparationLifecycleRead(root, read);
  const storage = read.snapshot.storage;
  const problems: PreparationInventoryProblem[] = [];
  if (storage.quarantine.health === "unavailable") {
    problems.push({
      dimension: "quarantine-storage",
      detail: "preparation quarantine storage is unavailable",
    });
  }
  // Prune physical health is deliberately NOT a capacity problem. Capacity's
  // problems gate staging and handoff settlement, and prune is outside quarantine
  // totals, outside the compatibility sum, and was never walked by the baseline
  // scanner — so gating on it is the guard-created dead end design V2 section 5.3
  // warns against. The health is carried on the snapshot for the reference/GC
  // consumers that genuinely need it.
  return { quarantine: storage.quarantine, problems };
}

/**
 * Compatibility health for the quarantine field.
 *
 * Unavailable when quarantine physical storage is unavailable, or when any
 * ACTIVE-side problem exists — the second clause preserves the baseline, where a
 * whole-inventory fault poisoned quarantine too.
 *
 * The epoch entries poison from the MERGED problem list instead. Since prune
 * faults no longer enter capacity at all, the only remaining lifecycle problems
 * (unavailable read, unavailable quarantine storage) both imply quarantine health
 * unavailable, so the two rules currently agree in every reachable state. They are
 * kept separate because they answer different questions, not because a divergence
 * is observable today.
 */
function quarantineCapacity(
  storage: PreparationLifecycleStorageEntryV1,
  activeUnavailable: boolean,
): PreparationEpochInventoryEntry {
  return {
    count: storage.count,
    bytes: storage.bytes,
    health: storage.health === "unavailable" || activeUnavailable
      ? "unavailable"
      : "ok",
  };
}

/** Add the old shared active-plus-quarantine entry exhaustion problem. */
function noteCombinedEntryBound(
  scan: ActivePreparationScan,
  lifecycle: LifecycleCapacityObservation,
  limit: number,
  problems: PreparationInventoryProblem[],
): void {
  if (scan.traversalEntries + lifecycle.quarantine.traversalEntries <= limit) return;
  problems.push({
    dimension: "directory-entries",
    detail: "preparation inventory entry bound exceeded",
  });
}

/** Read and validate every manifest-backed active preparation state. */
async function preparationStates(
  root: string,
  scan: ActivePreparationScan,
  problems: PreparationInventoryProblem[],
) {
  const manifests = await readManifests(root, scan.leaves, problems);
  const manifestList = [...manifests.values()];
  try {
    validatePreparationSupersessionSet(manifestList);
  } catch (error) {
    problems.push({ dimension: "supersession", detail: error instanceof Error ? error.message : "invalid supersession set" });
  }
  const states: PreparationState[] = [];
  for (const manifest of manifestList) states.push(await preparationState(root, manifest, scan.leaves, problems));
  return { manifestList, states };
}

/**
 * Inventory active storage from one supplied lifecycle observation. A successful
 * read must prove provenance, an active lease, and matching root before any
 * further I/O; an UNAVAILABLE read carries no such proof and is accepted from any
 * caller, because it can only produce a fail-closed capacity problem.
 */
export async function scanPreparationInventoryFromLifecycle(
  root: string,
  read: PreparationLifecycleReadV1,
  options: PreparationScanOptions = {},
): Promise<PreparationInventory> {
  const limit = preparationScanEntryLimit(options);
  const lifecycle = await lifecycleCapacity(root, read);
  const scan = await scanActivePreparationStore(root, options);
  const activeProblems = [...scan.problems];
  noteCombinedEntryBound(scan, lifecycle, limit, activeProblems);
  const { manifestList, states } = await preparationStates(
    root, scan, activeProblems,
  );
  const orphans = orphanLeaves(scan, states);
  const problems = [...activeProblems, ...lifecycle.problems];
  const summary = summarizeActive(scan, orphans, problems.length > 0);
  return {
    ...summary,
    quarantine: quarantineCapacity(
      lifecycle.quarantine,
      activeProblems.length > 0,
    ),
    activeNonterminalRuns: states.filter((item) => item.nonterminal).length,
    problems, manifests: manifestList, workspacePreparations: workspacePreparationCounts(scan),
    preparationIds: new Set(scan.preparationDirectories.map((item) => item.preparationId as PreparationId)),
    runIds: new Set(scan.leaves.filter((leaf) => leaf.kind === "run" && leaf.runId !== undefined && leaf.protocolAlias === undefined).map((leaf) => leaf.runId as PreparationRunId)),
  };
}

/** Inventory one project inside exactly one callback-scoped lifecycle read. */
export async function scanPreparationInventory(
  root: string,
  options: PreparationScanOptions = {},
): Promise<PreparationInventory> {
  const limit = preparationScanEntryLimit(options);
  return withPreparationLifecycleRead(
    root,
    (read) => scanPreparationInventoryFromLifecycle(root, read, options),
    { maxRegistryEntries: limit },
  );
}

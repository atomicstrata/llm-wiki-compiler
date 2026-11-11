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
 *
 * ONE BODY, OVER THE SCAN'S OWN READS. `scanPreparationInventoryFrom` is the
 * single body; it takes `PreparationInventoryReads` and no project root.
 * `scanPreparationInventoryFromLifecycle` keeps its signature and delegates to it
 * over the private local-disk reads, built on each call.
 *
 * ONE BORROW, DECIDED IN ONE BODY. `scanPreparationInventoryBorrowingFrom` holds
 * what the root form used to decide for itself: take the entry limit from the
 * caller's options, borrow exactly one lifecycle read at that limit, and run the
 * scan inside the borrow with that read. It takes
 * `PreparationInventoryLifecycleReads` and no project root. `scanPreparationInventory`
 * keeps its signature and reaches that body over the private local-disk reads,
 * whose borrow is the same lifecycle capture as before.
 *
 * THE CAPTURE ITSELF IS NOT MOVED AND NOT MADE NEUTRAL. Root identity, scanner
 * provenance, the lease and every physical lifecycle read stay in
 * `lifecycle-snapshot/read.ts` and `lifecycle-fs`: ROOT-BOUND LOCAL-DISK
 * AUTHORITY behind one line here. That is a named deferment, not an accepted
 * mechanism.
 *
 * THE BOUND BODY PROVES NOTHING ABOUT A LIFECYCLE READ. Whether a successful read
 * is scanner-minted, live, and belongs to this store is decided by
 * `reads.assertLifecycleRead`, so THE PROOF OBLIGATION LIES WITH WHOEVER SUPPLIES
 * THE READS. The local-disk reads carry the real check against their root. Reads
 * whose assertion always resolves would run the whole scan on any snapshot; for
 * that reason neither the bound body nor the interface is exported from a package
 * entry. What is bound here is this file's own decisions (problems and their
 * order, authority, orphans, health, totals). The five reads under it are NOT
 * made storage-neutral by being named: each decides things of its own and each
 * still takes a project root. Nothing here selects a backend.
 */

import path from "node:path";
import pLimit from "p-limit";
import { authoritativeManifests, hasAuthoritativeRun, capacityViolation, uniqueInventoryBytes as uniqueBytes } from "../utils/inventory-arithmetic.js";
import {
  MAX_ACTIVE_NONTERMINAL_RUNS, MAX_ACTIVE_PREPARATION_BYTES,
  MAX_ACTIVE_PREPARATIONS_PER_WORKSPACE, MAX_NEW_PREPARATIONS_PER_STAGING_CALL,
  MAX_PREPARATION_EVIDENCE_OBJECT_BYTES, MAX_PREPARATION_MANIFEST_BYTES,
  MAX_PREPARATION_RUN_BYTES, MAX_PREPARED_INPUTS_PER_RUN,
} from "./constants.js";
import type { PreparationId, PreparationRunId } from "./ids.js";
import type { PreparationEpochInventory, PreparationEpochInventoryEntry } from "./key-epoch.js";
import { readPreparationKeyEpoch } from "./key-epoch.js";
import { validatePreparationSupersessionSet } from "./manifest-graph.js";
import { preparationManifestDigest, type PreparationManifestV1 } from "./manifest-parse.js";
import { readPreparationManifest } from "./manifest-store.js";
import type { PreparationManifestRead } from "./manifest-store.js";
import {
  preparationScanEntryLimit, scanActivePreparationStore,
  type PreparationInventoryProblem,
  type PreparationLeafObservation, type PreparationOrphanScan, type PreparationScanOptions,
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
import type { PreparationRunRead } from "./run-store.js";
import type { PreparationRunBinding, PreparationRunState } from "./run-types.js";

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

/**
 * What the inventory scan asks of the preparation store. Owned by the scan; no
 * read takes a project root.
 */
export interface PreparationInventoryReads {
  /**
   * Prove a successful lifecycle read is genuine, live, and belongs to the store
   * these reads answer for; reject otherwise. THE SCAN RELIES ON THIS AND CHECKS
   * NOTHING ITSELF.
   */
  assertLifecycleRead(read: PreparationLifecycleReadV1): Promise<void>;
  /** The active store's leaves, directories, problems and entry use. */
  scanActiveStore(options: PreparationScanOptions): Promise<PreparationOrphanScan>;
  /** One manifest by workspace and preparation. */
  readManifest(workspaceId: string, preparationId: PreparationId): Promise<PreparationManifestRead>;
  /** Whether the preparation key can be read, and its epoch. NEVER the key bytes. */
  readKeyEpoch(): Promise<
    | { status: "ok"; keyEpochId: PreparationRunBinding["keyEpochId"] }
    | { status: "absent" }
    | { status: "unavailable" }
  >;
  /** One run leaf by its binding, authenticated by whatever answers. */
  readRun(binding: PreparationRunBinding): Promise<PreparationRunRead>;
}

/**
 * The scan's reads TOGETHER WITH the means to borrow the lifecycle read they
 * prove. A SEPARATE interface: a caller that already holds a read supplies
 * {@link PreparationInventoryReads} and never borrows, so it is not made to
 * implement a borrow it would never be asked for.
 *
 * ONE SUPPLIER ACQUIRES AND PROVES. `borrowLifecycleRead` and
 * `assertLifecycleRead` answer for the same store, so a successful read lent
 * here is one the proof here accepts while the callback runs. THE INTERFACE
 * AUTHENTICATES NOTHING. Keeping that relationship is the supplier's
 * obligation; a borrow from one authority paired with a proof from another is
 * a defect this type cannot see.
 */
export interface PreparationInventoryLifecycleReads extends PreparationInventoryReads {
  /**
   * Lend ONE lifecycle read, captured over at most `maxRegistryEntries`
   * registry entries, for the length of `use`, and settle as `use` settles. A
   * read that could not be captured is lent as `unavailable`, not rejected. A
   * successful read stops being valid once `use` has settled.
   */
  borrowLifecycleRead<T>(
    maxRegistryEntries: number, use: (read: PreparationLifecycleReadV1) => Promise<T>,
  ): Promise<T>;
}

/**
 * The local-disk reads for one project root. Private, and built per call: each
 * closure calls the imported store function when it is asked, never earlier. The
 * lifecycle proof here is the real one, against this root.
 */
function diskPreparationInventoryReads(root: string): PreparationInventoryReads {
  return {
    assertLifecycleRead: (read) => assertPreparationLifecycleRead(root, read),
    scanActiveStore: (options) => scanActivePreparationStore(root, options),
    readManifest: (workspaceId, preparationId) => readPreparationManifest(root, workspaceId, preparationId),
    readKeyEpoch: () => readPreparationKeyEpoch(root),
    readRun: (binding) => readPreparationRun(root, binding),
  };
}

/**
 * The local-disk reads that can also borrow, for one project root. Private, and
 * built per call. The borrow is the imported lifecycle capture for this root,
 * called when it is asked and never earlier, so the read it lends is the one the
 * proof beside it accepts. ROOT-BOUND LOCAL-DISK AUTHORITY: named, not neutral.
 */
function diskPreparationInventoryLifecycleReads(root: string): PreparationInventoryLifecycleReads {
  return {
    ...diskPreparationInventoryReads(root),
    borrowLifecycleRead: (maxRegistryEntries, use) => withPreparationLifecycleRead(root, use, { maxRegistryEntries }),
  };
}

/**
 * How many store reads one scan keeps in flight. The reads are independent and
 * each waits on the disk, so a store of many runs is scanned in a fraction of
 * the time a one-at-a-time walk takes. Results are still reported in leaf order.
 */
const SCAN_READ_CONCURRENCY = 16;

/** Read every authoritative manifest and preserve invalid/unavailable state. */
async function readManifests(
  reads: PreparationInventoryReads, leaves: readonly PreparationLeafObservation[], problems: PreparationInventoryProblem[],
): Promise<Map<string, PreparationManifestV1>> {
  const limit = pLimit(SCAN_READ_CONCURRENCY);
  const identified = authoritativeManifests(leaves).flatMap((leaf) =>
    leaf.workspaceId === undefined || leaf.preparationId === undefined
      ? [] : [{ leaf, workspaceId: leaf.workspaceId, preparationId: leaf.preparationId as PreparationId }]);
  const read = await Promise.all(identified.map((item) => limit(() => reads.readManifest(item.workspaceId, item.preparationId))));
  const result = new Map<string, PreparationManifestV1>();
  identified.forEach(({ leaf, workspaceId, preparationId }, index) => {
    const outcome = read[index];
    if (outcome.status === "ok") result.set(`${workspaceId}\0${preparationId}`, outcome.manifest);
    else problems.push({ dimension: "manifest-state", detail: `preparation manifest is ${outcome.status}`, path: path.join(".llmwiki", leaf.relativePath) });
  });
  return result;
}

type KeyEpochRead = Awaited<ReturnType<PreparationInventoryReads["readKeyEpoch"]>>;

/** One manifest's state, with the problem that made it incomplete, if any. */
interface PreparationStateOutcome { state: PreparationState; problem?: PreparationInventoryProblem }

/** Verify one manifest's initial evidence, run leaf, and authenticated run. */
async function preparationState(
  reads: PreparationInventoryReads, manifest: PreparationManifestV1, leaves: readonly PreparationLeafObservation[],
  keyEpoch: () => Promise<KeyEpochRead>,
): Promise<PreparationStateOutcome> {
  const incomplete: PreparationState = { manifest, complete: false, nonterminal: false };
  const evidencePresent = manifest.initialEvidence.every((evidence) => leaves.some((leaf) =>
    leaf.kind === "evidence" && leaf.workspaceId === manifest.workspaceId && leaf.preparationId === manifest.preparationId
    && leaf.protocolAlias === undefined && path.basename(leaf.logicalRelativePath) === evidence.digest.slice("sha256:".length)));
  const runLeaf = hasAuthoritativeRun(leaves, manifest);
  if (!evidencePresent || !runLeaf) return { state: incomplete };
  const key = await keyEpoch();
  if (key.status !== "ok") return { state: incomplete, problem: { dimension: "run-state", detail: `preparation key is ${key.status}` } };
  const run = await reads.readRun({
    runId: manifest.runId, preparationId: manifest.preparationId, workspaceId: manifest.workspaceId,
    manifestDigest: preparationManifestDigest(manifest), keyEpochId: key.keyEpochId,
  });
  if (run.status !== "ok") return { state: incomplete, problem: { dimension: "run-state", detail: `preparation run is ${run.status}` } };
  return { state: { manifest, complete: true, nonterminal: !TERMINAL_STATES.has(run.run.state) } };
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
  reads: PreparationInventoryReads,
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
  await reads.assertLifecycleRead(read);
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
  reads: PreparationInventoryReads,
  scan: ActivePreparationScan,
  problems: PreparationInventoryProblem[],
) {
  const manifests = await readManifests(reads, scan.leaves, problems);
  const manifestList = [...manifests.values()];
  try {
    validatePreparationSupersessionSet(manifestList);
  } catch (error) {
    problems.push({ dimension: "supersession", detail: error instanceof Error ? error.message : "invalid supersession set" });
  }
  // The key epoch is one fact about the store, so one scan reads it once and
  // every run is authenticated against that same reading.
  let keyRead: Promise<KeyEpochRead> | undefined;
  const keyEpoch = () => (keyRead ??= reads.readKeyEpoch());
  const limit = pLimit(SCAN_READ_CONCURRENCY);
  const outcomes = await Promise.all(manifestList.map((manifest) =>
    limit(() => preparationState(reads, manifest, scan.leaves, keyEpoch))));
  for (const { problem } of outcomes) if (problem) problems.push(problem);
  return { manifestList, states: outcomes.map((outcome) => outcome.state) };
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
  return scanPreparationInventoryFrom(diskPreparationInventoryReads(root), read, options);
}

/**
 * {@link scanPreparationInventoryFromLifecycle} over the scan's reads: the one
 * body. IT PROVES NOTHING ITSELF: a successful `read` is trusted exactly as far
 * as `reads.assertLifecycleRead` vouches for it, so the caller who supplies the
 * reads owns that proof. An unavailable read is not asserted and can only
 * produce a fail-closed problem.
 */
export async function scanPreparationInventoryFrom(
  reads: PreparationInventoryReads,
  read: PreparationLifecycleReadV1,
  options: PreparationScanOptions = {},
): Promise<PreparationInventory> {
  const limit = preparationScanEntryLimit(options);
  const lifecycle = await lifecycleCapacity(reads, read);
  const scan = await reads.scanActiveStore(options);
  const activeProblems = [...scan.problems];
  noteCombinedEntryBound(scan, lifecycle, limit, activeProblems);
  const { manifestList, states } = await preparationStates(
    reads, scan, activeProblems,
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
  return scanPreparationInventoryBorrowingFrom(diskPreparationInventoryLifecycleReads(root), options);
}

/**
 * {@link scanPreparationInventory} over the scan's reads and their borrow: the
 * one body. The entry limit is taken from `options` FIRST, so an option the
 * scanner refuses rejects before anything is borrowed. Then exactly one read is
 * borrowed at that limit, and the whole scan runs inside the borrow with that
 * read and the SAME `options` object; the scan body derives its own limit from
 * it again, as it did before. Nothing is caught here.
 */
export async function scanPreparationInventoryBorrowingFrom(
  reads: PreparationInventoryLifecycleReads,
  options: PreparationScanOptions = {},
): Promise<PreparationInventory> {
  const limit = preparationScanEntryLimit(options);
  return reads.borrowLifecycleRead(limit, (read) => scanPreparationInventoryFrom(reads, read, options));
}

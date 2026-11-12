/**
 * @file src/preparations/orphan-scan.ts
 * @description Bounded, no-follow traversal of the complete preparation store
 * (design sections 8.4, 26.2, 26.4). The scanner descends ONLY the preparation
 * roots. Capacity uses the active-store entry point; destructive planning alone
 * retains the active-plus-quarantine compatibility entry point until Tasks
 * 9D/9E. Co-located Milestone A subtrees are a different store's namespace and
 * are ignored rather than mis-counted as orphans. Every unknown or unreadable
 * leg is reported instead of silently omitted.
 *
 * ONE WALK, OVER THE SCANNER'S OWN READS. The walk, the classifiers, the
 * directory policy, the byte caps, the entry and depth budgets, the order and
 * every problem's words live in one body that takes `PreparationStoreWalkReads`
 * and no project root; it works in paths relative to the store's `.llmwiki`.
 * The two root-named entry points keep their signatures and delegate to the
 * two `…From` bodies over the private local-disk reads, built on each call.
 * No file handle crosses the seam: a directory is visited by a provider that
 * opens, lists and releases it, and a leaf is observed and released before the
 * answer. On disk that is the same no-follow, confined, handle-bound code as
 * before, in `utils/inventory-scan.ts`. Binding the walk makes nothing below it
 * storage-neutral, and nothing here selects a backend.
 */

import path from "node:path";
import {
  durableAlias, verified, positiveScanEntryLimit, captureInventoryLeaf, walkInventoryTree, type InventoryLeafObserver,
} from "../utils/inventory-scan.js";
import { diskInventoryWalkReads } from "../utils/inventory-disk-walk.js";
import type { ScannedLeafBytes } from "../utils/scanned-leaf-bytes.js";
import { assertPreparationId, assertPreparationRunId } from "./ids.js";
import {
  MAX_PREPARATION_INVENTORY_ENTRIES,
  MAX_PREPARATION_EVIDENCE_OBJECT_BYTES, MAX_PREPARATION_MANIFEST_BYTES,
  MAX_PREPARATION_RUN_BYTES,
} from "./constants.js";
import {
  assertWorkspaceId, EVIDENCE_SEGMENT, MANIFEST_FILENAME, PREPARATIONS_SEGMENT,
  PREPARATION_QUARANTINE_SEGMENT, PREPARATION_RUNS_SEGMENT,
} from "./paths.js";

const MAX_SCAN_DEPTH = 32;
const SHA256 = /^[0-9a-f]{64}$/;
const PORTABLE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/** Filesystem problem that makes a staging inventory untrustworthy. */
export interface PreparationInventoryProblem { dimension: string; detail: string; path?: string }

/** Preparation namespace owned by one observed regular file. */
export type PreparationLeafKind = "manifest" | "evidence" | "run" | "cancel" | "quarantine" | "unknown";

/** Handle-bound metadata for one literal regular leaf. */
export interface PreparationLeafObservation {
  relativePath: string;
  logicalRelativePath: string;
  kind: PreparationLeafKind;
  bytes: number;
  dev: number;
  ino: number;
  workspaceId?: string;
  preparationId?: string;
  runId?: string;
  protocolAlias?: "tmp" | "writing";
}

/** Bounded scan result: active-only for capacity, combined for destructive planning. */
export interface PreparationOrphanScan {
  leaves: readonly PreparationLeafObservation[];
  workspaces: readonly string[];
  preparationDirectories: readonly { workspaceId: string; preparationId: string }[];
  problems: readonly PreparationInventoryProblem[];
  traversalEntries: number;
}

/** Test-only lower bound for deterministic directory-exhaustion coverage. */
export interface PreparationScanOptions { maxDirectoryEntriesForTest?: number }

/** One directory entry as the scanner reads it: a name and three kind tests. */
export interface PreparationStoreEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/**
 * What the scanner asks of the store. Owned by the scanner. Every path is
 * relative to the store's `.llmwiki`; no member takes a project root and no
 * file handle crosses in either direction.
 */
export interface PreparationStoreWalkReads {
  /**
   * Visit one directory. THE PROVIDER'S CONTRACT, which the scanner cannot check:
   *  - ORDER: obtain an entry, THEN call `take()`. Never call `take()` when no
   *    entry is in hand, so never at the end of a directory. If `take()` is
   *    false, deliver nothing more from this visit; otherwise await
   *    `inspect(entry)` before obtaining the next — except that a provider
   *    may obtain a bounded run of entries ahead and deliver them in order
   *    (the disk walk reads ahead consecutive files to prove their directory
   *    once). An entry may have been obtained and not delivered; nothing here
   *    bounds what the store reads.
   *  - REFUSALS: answer `absent`, `unavailable` or `unlistable` ONLY when
   *    neither `take` nor `inspect` was called. A failure after that REJECTS.
   *  - NAMES: each name is one non-empty path segment, not `.` or `..`, with no
   *    separator. The scanner joins names into paths and does not re-check them.
   *  - RELEASE: whatever the visit holds is released on every path, including
   *    when `inspect` rejects. `inspect` may start a nested visit.
   */
  visitDirectory(
    directory: string,
    visitor: { take(): boolean; inspect(entry: PreparationStoreEntry): Promise<void> },
  ): Promise<"visited" | "absent" | "unavailable" | "unlistable">;
  /**
   * One leaf's size and identity, taken from the opened leaf and nothing else;
   * nothing stays open afterwards. `dev` and `ino` are an identity pair: equal
   * pairs mean the same stored object, because byte totals count by them.
   * A manifest or run leaf is asked with its cap as `retainUpToBytes`
   * ({@link InventoryLeafObserver}).
   */
  observeLeaf: InventoryLeafObserver;
}

interface ScanState {
  reads: PreparationStoreWalkReads;
  maxEntries: number;
  entries: number;
  exhausted: boolean;
  leaves: PreparationLeafObservation[];
  workspaces: Set<string>;
  preparationDirectories: Map<string, { workspaceId: string; preparationId: string }>;
  problems: PreparationInventoryProblem[];
}

type ClassifiedLeaf = Omit<PreparationLeafObservation, "relativePath" | "logicalRelativePath" | "bytes" | "dev" | "ino">;
type DirectoryPolicy = "descend" | "ignore" | "flag";

const LEAF_BYTE_CAPS: Partial<Record<PreparationLeafKind, number>> = {
  manifest: MAX_PREPARATION_MANIFEST_BYTES,
  evidence: MAX_PREPARATION_EVIDENCE_OBJECT_BYTES,
  run: MAX_PREPARATION_RUN_BYTES,
  cancel: MAX_PREPARATION_RUN_BYTES,
};

/** Record one problem against a store-relative path, reported as the project-relative path it always was. */
function problem(state: ScanState, dimension: string, detail: string, relative: string): void {
  state.problems.push({ dimension, detail, path: path.join(".llmwiki", relative) });
}

/** Classify one preparation-owned regular leaf from validated path segments. */
function classifyLeaf(relative: string): ClassifiedLeaf {
  const parts = relative.split(path.sep);
  if (parts[0] === PREPARATION_QUARANTINE_SEGMENT) return { kind: "quarantine" };
  if (parts[0] !== "workspaces") return { kind: "unknown" };
  const workspaceId = parts[1];
  if (workspaceId === undefined || verified(() => assertWorkspaceId(workspaceId)) === null) return { kind: "unknown" };
  const name = parts.at(-1) ?? "", aliased = durableAlias(name);
  const classified = classifyWorkspaceLeaf(workspaceId, [...parts.slice(0, -1), aliased.base]);
  if (classified.kind === "unknown" || aliased.alias === undefined) return classified;
  return { ...classified, protocolAlias: aliased.alias };
}

/** Recognize manifest, evidence, run, and cancel leaves in one workspace. */
function classifyWorkspaceLeaf(workspaceId: string, parts: readonly string[]): ClassifiedLeaf {
  if (parts[2] === PREPARATIONS_SEGMENT) return classifyPreparationLeaf(workspaceId, parts);
  if (parts[2] === PREPARATION_RUNS_SEGMENT) return classifyRunLeaf(workspaceId, parts);
  return { kind: "unknown", workspaceId };
}

/** Recognize an immutable manifest or a content-addressed evidence leaf. */
function classifyPreparationLeaf(workspaceId: string, parts: readonly string[]): ClassifiedLeaf {
  const preparationId = verified(() => assertPreparationId(parts[3]));
  if (preparationId === null) return { kind: "unknown", workspaceId };
  const tail = parts.slice(4);
  if (tail.length === 1 && tail[0] === MANIFEST_FILENAME) return { kind: "manifest", workspaceId, preparationId };
  if (tail.length === 2 && tail[0] === EVIDENCE_SEGMENT && SHA256.test(tail[1] ?? "")) {
    return { kind: "evidence", workspaceId, preparationId };
  }
  return { kind: "unknown", workspaceId, preparationId };
}

/** Recognize one authenticated run leaf or its cancellation request. */
function classifyRunLeaf(workspaceId: string, parts: readonly string[]): ClassifiedLeaf {
  if (parts.length !== 4) return { kind: "unknown", workspaceId };
  const match = /^(prr_[0-9a-f]{32})\.(json|cancel)$/.exec(parts[3] ?? "");
  const runId = match === null ? null : verified(() => assertPreparationRunId(match[1]));
  if (runId === null) return { kind: "unknown", workspaceId };
  return { kind: match?.[2] === "json" ? "run" : "cancel", workspaceId, runId };
}

/** Decide whether to descend, ignore (foreign store), or flag one directory. */
function directoryPolicy(relative: string): DirectoryPolicy {
  if (relative === "") return "descend";
  const parts = relative.split(path.sep);
  if (parts[0] === PREPARATION_QUARANTINE_SEGMENT) return quarantineDirectoryPolicy(parts);
  if (parts[0] !== "workspaces") return "ignore";
  if (parts.length === 1) return "descend";
  return workspaceDirectoryPolicy(parts);
}

/** Quarantine descends only through portable reset-id partitions. */
function quarantineDirectoryPolicy(parts: readonly string[]): DirectoryPolicy {
  if (parts.length === 1) return "descend";
  return parts.slice(1).every((part) => PORTABLE.test(part)) ? "descend" : "flag";
}

/** Preparation subtrees descend; the co-located Milestone A subtrees are ignored. */
function workspaceDirectoryPolicy(parts: readonly string[]): DirectoryPolicy {
  if (parts.length === 2) return verified(() => assertWorkspaceId(parts[1])) === null ? "ignore" : "descend";
  if (verified(() => assertWorkspaceId(parts[1])) === null) return "ignore";
  if (parts[2] === PREPARATIONS_SEGMENT) return preparationDirectoryPolicy(parts);
  if (parts[2] === PREPARATION_RUNS_SEGMENT) return parts.length === 3 ? "descend" : "flag";
  return "ignore";
}

/** A preparation directory descends into its own evidence directory only. */
function preparationDirectoryPolicy(parts: readonly string[]): DirectoryPolicy {
  if (parts.length === 3) return "descend";
  if (verified(() => assertPreparationId(parts[3])) === null) return "flag";
  if (parts.length === 4) return "descend";
  return parts.length === 5 && parts[4] === EVIDENCE_SEGMENT ? "descend" : "flag";
}

/** Track verified workspace and preparation directory identities for orphan logic. */
function captureDirectoryIdentity(state: ScanState, relative: string): void {
  const parts = relative.split(path.sep);
  if (parts.length === 2 && parts[0] === "workspaces") {
    const workspaceId = verified(() => assertWorkspaceId(parts[1]));
    if (workspaceId !== null) state.workspaces.add(workspaceId);
  }
  if (parts.length !== 4 || parts[0] !== "workspaces" || parts[2] !== PREPARATIONS_SEGMENT) return;
  const workspaceId = verified(() => assertWorkspaceId(parts[1]));
  const preparationId = verified(() => assertPreparationId(parts[3]));
  if (workspaceId !== null && preparationId !== null) {
    state.preparationDirectories.set(`${workspaceId}\0${preparationId}`, { workspaceId, preparationId });
  }
}

/** Capture one opened regular file and its protocol-aware classification. */
async function captureLeaf(state: ScanState, file: string, parent: string): Promise<void> {
  await captureInventoryLeaf((leaf, dir, retainUpToBytes) => state.reads.observeLeaf(leaf, dir, retainUpToBytes), file, parent, {
    label: "preparation",
    problem: (dimension, detail, relative) => problem(state, dimension, detail, relative),
    classify: classifyLeaf,
    noteCap: (kind, bytes, leaf) => noteLeafCap(state, kind, bytes, leaf),
    record: (observation) => { state.leaves.push(observation); },
    retainUpTo: retainedLeafCap,
  });
}

/** The cap under which a manifest or run leaf the inventory goes on to read may be kept; no other leaf is. */
function retainedLeafCap(classified: ClassifiedLeaf): number | undefined {
  if (classified.protocolAlias !== undefined) return undefined;
  return classified.kind === "manifest" || classified.kind === "run" ? LEAF_BYTE_CAPS[classified.kind] : undefined;
}

/** Refuse a recognized leaf whose metadata already exceeds its local cap. */
function noteLeafCap(state: ScanState, kind: PreparationLeafKind, bytes: number, file: string): void {
  const cap = LEAF_BYTE_CAPS[kind];
  if (cap !== undefined && bytes > cap) problem(state, `${kind}-bytes`, "preparation leaf exceeds its byte cap", file);
}

/** Consume one unit from the global traversal bound. */
function takeEntry(state: ScanState, dir: string): boolean {
  state.entries += 1;
  if (state.entries <= state.maxEntries) return true;
  state.exhausted = true;
  problem(state, "directory-entries", "preparation inventory entry bound exceeded", dir);
  return false;
}

/** Inspect one directory entry without duplicating topology decisions. */
async function inspectEntry(state: ScanState, entry: PreparationStoreEntry, dir: string, depth: number): Promise<void> {
  const child = path.join(dir, entry.name), relative = child;
  if (entry.isDirectory()) {
    const policy = directoryPolicy(relative);
    if (policy === "ignore") return;
    if (policy === "flag") { problem(state, "preparation-entry", "unknown preparation directory", child); return; }
    captureDirectoryIdentity(state, relative);
    await walk(state, child, depth + 1);
    return;
  }
  const parts = relative.split(path.sep);
  if (parts.length === 3 && parts[0] === "workspaces" && entry.name === "catalog.jsonl") return;
  if (entry.isFile() || entry.isSymbolicLink()) { await captureLeaf(state, child, dir); return; }
  problem(state, "preparation-entry", "unsupported preparation entry", child);
}

/** Traverse until the global entry bound is reached, then fail closed. */
async function walk(state: ScanState, dir: string, depth: number): Promise<void> {
  await walkInventoryTree(state, dir, depth, { label: "preparation", maxDepth: MAX_SCAN_DEPTH, problem, takeEntry, inspectEntry });
}

/** Return the effective host-capped entry ceiling for one scan request. */
export function preparationScanEntryLimit(
  options: PreparationScanOptions = {},
): number {
  const requested = positiveScanEntryLimit(options.maxDirectoryEntriesForTest ?? MAX_PREPARATION_INVENTORY_ENTRIES, "preparation");
  return Math.min(requested, MAX_PREPARATION_INVENTORY_ENTRIES);
}

/** Initialize one isolated scan without traversing any physical store. */
function scanState(
  reads: PreparationStoreWalkReads,
  options: PreparationScanOptions,
): ScanState {
  return {
    reads,
    maxEntries: preparationScanEntryLimit(options),
    entries: 0, exhausted: false, leaves: [], workspaces: new Set(), preparationDirectories: new Map(), problems: [],
  };
}

/** Freeze one completed scan result while exposing its actual entry use. */
function scanResult(state: ScanState): PreparationOrphanScan {
  return {
    leaves: state.leaves, workspaces: [...state.workspaces].sort(),
    preparationDirectories: [...state.preparationDirectories.values()]
      .sort((left, right) => `${left.workspaceId}/${left.preparationId}`.localeCompare(`${right.workspaceId}/${right.preparationId}`)),
    problems: state.problems, traversalEntries: state.entries,
  };
}

/**
 * The local-disk reads for one project root. Built per call, and PURE to
 * build: two lexical path resolutions and no I/O. Each closure joins the
 * store-relative path back under the resolved `.llmwiki` and calls the shared
 * primitive with the resolved root, as the scan state did before. Exported for
 * the store's leaf composition (`store-leaf-reads.ts`) only; in no package index.
 */
export function diskPreparationStoreWalkReads(root: string, scanned?: ScannedLeafBytes): PreparationStoreWalkReads {
  return diskInventoryWalkReads(root, ".llmwiki", scanned);
}

/**
 * Inventory active preparation storage without entering a lifecycle registry.
 * A pass that goes on to read the manifests and runs hands in its `scanned`
 * holder, so the walk's reads of those leaves are the ones its readers consume.
 */
export async function scanActivePreparationStore(
  root: string,
  options: PreparationScanOptions = {},
  scanned?: ScannedLeafBytes,
): Promise<PreparationOrphanScan> {
  return scanActivePreparationStoreFrom(diskPreparationStoreWalkReads(root, scanned), options);
}

/** {@link scanActivePreparationStore} over the scanner's reads: the active walk only. */
export async function scanActivePreparationStoreFrom(
  reads: PreparationStoreWalkReads,
  options: PreparationScanOptions = {},
): Promise<PreparationOrphanScan> {
  const state = scanState(reads, options);
  await walk(state, "workspaces", 0);
  return scanResult(state);
}

/**
 * Inventory active and quarantine storage for destructive compatibility only.
 * Capacity must use {@link scanActivePreparationStore}.
 */
export async function scanPreparationOrphans(
  root: string,
  options: PreparationScanOptions = {},
): Promise<PreparationOrphanScan> {
  return scanPreparationOrphansFrom(diskPreparationStoreWalkReads(root), options);
}

/**
 * {@link scanPreparationOrphans} over the scanner's reads: the active walk, then
 * the quarantine segment, on ONE state, so one budget spans both. THIS WALKS THE
 * LIFECYCLE REGISTRY, exactly as the root form does; capacity and destructive
 * planning must use neither.
 */
export async function scanPreparationOrphansFrom(
  reads: PreparationStoreWalkReads,
  options: PreparationScanOptions = {},
): Promise<PreparationOrphanScan> {
  const state = scanState(reads, options);
  await walk(state, "workspaces", 0);
  await walk(state, PREPARATION_QUARANTINE_SEGMENT, 0);
  return scanResult(state);
}

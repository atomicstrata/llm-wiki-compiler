/**
 * @file src/operation-bundles/orphan-scan.ts
 * @description Bounded, no-follow traversal of the complete operation store.
 * The scanner classifies protocol-owned durable aliases explicitly and reports
 * every unknown or unreadable leg instead of silently omitting capacity.
 *
 * ONE WALK, OVER THE SCANNER'S OWN READS. The walk, the classifiers, the
 * directory policy, the byte caps, the entry and depth budgets, the order and
 * every problem's words live in one body, `scanOperationOrphansFrom`, that takes
 * `OperationStoreWalkReads` and no project root; it works in paths relative to
 * `.llmwiki/workspaces` and reports each problem path as the project-relative
 * path it always was. `scanOperationOrphans` keeps its signature and delegates
 * over the local-disk reads, built on each call, which are the same no-follow,
 * confined, handle-bound primitives in `utils/inventory-scan.ts` as before. No
 * file handle crosses the seam, and nothing here selects a backend.
 */

import path from "node:path";
import {
  durableAlias, verified, positiveScanEntryLimit, captureInventoryLeaf, walkInventoryTree, type InventoryLeafObserver,
} from "../utils/inventory-scan.js";
import { diskInventoryWalkReads } from "../utils/inventory-disk-walk.js";
import type { ScannedLeafBytes } from "../utils/scanned-leaf-bytes.js";
import { assertBundleId, assertOperationRunId } from "./ids.js";
import {
  MAX_CATALOG_FILE_BYTES, MAX_MANIFEST_BYTES, MAX_PAYLOAD_BYTES,
  MAX_PROJECTION_BYTES, MAX_RETAINED_SOURCE_BYTES, MAX_RUN_BYTES,
  MAX_RUN_EVIDENCE_BLOB_BYTES,
} from "./constants.js";
import {
  assertRecipeId, assertWorkspaceId, PROJECTION_MARKER_SUFFIX, SOURCES_SEGMENT,
} from "./paths.js";

const DEFAULT_MAX_ENTRIES = 100_000;
const MAX_SCAN_DEPTH = 32;

/**
 * Second-level workspace segments owned by a DIFFERENT store that shares the
 * `.llmwiki/workspaces/<ws>/` root — currently the Orchestration V2 preparation
 * store (`preparations`, `preparation-runs`). The operation-bundle inventory
 * neither owns nor understands these, so it skips them wholesale rather than
 * flagging every preparation leaf as an unknown operation entry, which would
 * otherwise wedge the shared recovery gate on any project that has preparations.
 */
const FOREIGN_STORE_WORKSPACE_SEGMENTS = new Set(["preparations", "preparation-runs"]);

/** True for a `<ws>/<foreign-segment>` directory the operation scanner must skip. */
function isForeignStoreDirectory(relative: string): boolean {
  const parts = relative.split(path.sep);
  return parts.length === 2 && FOREIGN_STORE_WORKSPACE_SEGMENTS.has(parts[1] ?? "");
}
const SHA256 = /^[0-9a-f]{64}$/;
const PORTABLE_OUTPUT = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const MAX_PROJECTION_MARKER_BYTES = 4 * 1024;

/** Filesystem problem that makes a staging inventory untrustworthy. */
export interface OperationInventoryProblem {
  dimension: string;
  detail: string;
  path?: string;
}

/** Operation namespace owned by one observed regular file. */
export type OperationLeafKind =
  | "manifest" | "payload" | "run" | "cancel" | "evidence"
  | "source" | "catalog" | "projection" | "projection-marker"
  | "quarantine" | "unknown";

/** Handle-bound metadata for one literal regular leaf. */
export interface OperationLeafObservation {
  relativePath: string;
  logicalRelativePath: string;
  kind: OperationLeafKind;
  bytes: number;
  dev: number;
  ino: number;
  workspaceId?: string;
  bundleId?: string;
  runId?: string;
  protocolAlias?: "tmp" | "writing";
}

/** Complete bounded result consumed by capacity and graph preflight. */
export interface OperationOrphanScan {
  leaves: readonly OperationLeafObservation[];
  workspaces: readonly string[];
  bundleDirectories: readonly { workspaceId: string; bundleId: string }[];
  problems: readonly OperationInventoryProblem[];
  /**
   * What the walk saw, workspaces-relative: every directory it listed in full
   * (`""` is the store root) and every entry it found in one. A problem-free scan
   * thereby proves a path ABSENT below a listed, confined directory
   * ({@link walkProvesAbsent}).
   */
  listing: { directories: ReadonlySet<string>; entries: ReadonlySet<string> };
}

/**
 * Whether a problem-free walk proves every one of `relativePaths` (siblings in
 * one directory, workspaces-relative) absent: descending from the store root,
 * each directory on the way was listed in full (so its realpath was proved its
 * canonical in-root path, as the confined absence check proves of the nearest
 * existing ancestor), and the first segment not found in its listed parent is
 * absent with all below it. A segment the walk found but did not list, or the
 * store root itself unlisted, proves nothing.
 */
export function walkProvesAbsent(listing: OperationOrphanScan["listing"], relativePaths: readonly string[]): boolean {
  const parts = relativePaths[0]!.split(path.sep);
  for (let depth = 0, dir = ""; depth < parts.length; depth++) {
    if (!listing.directories.has(dir)) return false;
    if (depth === parts.length - 1) return relativePaths.every((item) => !listing.entries.has(item));
    const child = path.join(dir, parts[depth]!);
    if (!listing.entries.has(child)) return true;
    dir = child;
  }
  return false;
}

/** Test-only lower bound for deterministic directory-exhaustion coverage. */
export interface OperationScanOptions {
  maxDirectoryEntriesForTest?: number;
}

/** One directory entry as the scanner reads it: a name and three kind tests. */
export interface OperationStoreEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/**
 * What the scanner asks of the operation store, in the shape of
 * `PreparationStoreWalkReads`. Every path is relative to `.llmwiki/workspaces`
 * (the root is `""`); no member takes a project root.
 */
export interface OperationStoreWalkReads {
  /**
   * Visit one directory: obtain an entry, THEN call `take()`; if it is false
   * deliver nothing more, otherwise await `inspect(entry)` before the next
   * (a provider may obtain a bounded run ahead and deliver it in order).
   * Answer `absent`, `unavailable` or `unlistable` ONLY before any entry was
   * delivered; a failure after that REJECTS. Each name is one path segment.
   */
  visitDirectory(
    directory: string,
    visitor: { take(): boolean; inspect(entry: OperationStoreEntry): Promise<void> },
  ): Promise<"visited" | "absent" | "unavailable" | "unlistable">;
  /** One leaf's size and identity from the opened leaf ({@link InventoryLeafObserver}); nothing stays open afterwards. */
  observeLeaf: InventoryLeafObserver;
}

interface ScanState {
  reads: OperationStoreWalkReads;
  listed: { directories: Set<string>; entries: Set<string> };
  maxEntries: number;
  entries: number;
  exhausted: boolean;
  leaves: OperationLeafObservation[];
  workspaces: Set<string>;
  bundleDirectories: Map<string, { workspaceId: string; bundleId: string }>;
  problems: OperationInventoryProblem[];
}

type ClassifiedLeaf = Omit<OperationLeafObservation,
"relativePath" | "logicalRelativePath" | "bytes" | "dev" | "ino">;

type LeafClassifier = (
  workspaceId: string,
  parts: readonly string[],
) => ClassifiedLeaf | null;

/** Record one problem against a workspaces-relative path, reported as the project-relative path it always was. */
function problem(state: ScanState, dimension: string, detail: string, relative: string): void {
  state.problems.push({ dimension, detail, path: path.join(".llmwiki", "workspaces", relative) });
}

/** Classify one regular leaf solely from validated literal path segments. */
function classifyLeaf(relative: string): ClassifiedLeaf {
  const parts = relative.split(path.sep), workspaceId = parts[0];
  if (workspaceId === ".quarantine") return { kind: "quarantine" };
  if (workspaceId === undefined || verified(() => assertWorkspaceId(workspaceId)) === null) {
    return { kind: "unknown" };
  }
  const name = parts.at(-1) ?? "", aliased = durableAlias(name);
  const baseParts = [...parts.slice(0, -1), aliased.base];
  const classified = classifyWorkspaceLeaf(workspaceId, baseParts);
  if (classified.kind === "unknown" || aliased.alias === undefined) return classified;
  return { ...classified, protocolAlias: aliased.alias };
}

/** Recognize every owned workspace leaf, including projection descendants. */
function classifyWorkspaceLeaf(
  workspaceId: string,
  parts: readonly string[],
): ClassifiedLeaf {
  const classifiers: readonly LeafClassifier[] = [
    catalogLeaf, bundleLeaf, runLeaf, sourceLeaf, projectionLeaf,
  ];
  for (const classify of classifiers) {
    const result = classify(workspaceId, parts);
    if (result !== null) return result;
  }
  return { kind: "unknown", workspaceId };
}

/** Recognize the workspace catalog as one bounded authoritative leaf. */
function catalogLeaf(workspaceId: string, parts: readonly string[]): ClassifiedLeaf | null {
  return parts.length === 2 && parts[1] === "catalog.jsonl"
    ? { kind: "catalog", workspaceId } : null;
}

/** Recognize one content-addressed retained source leaf. */
function sourceLeaf(workspaceId: string, parts: readonly string[]): ClassifiedLeaf | null {
  return parts.length === 3 && parts[1] === SOURCES_SEGMENT && SHA256.test(parts[2] ?? "")
    ? { kind: "source", workspaceId } : null;
}

/** Recognize immutable bundle manifests and content-addressed payloads. */
function bundleLeaf(workspaceId: string, parts: readonly string[]): ClassifiedLeaf | null {
  if (parts[1] !== "bundles" || parts[2] === undefined) return null;
  const bundleId = verified(() => assertBundleId(parts[2]));
  if (bundleId === null) return { kind: "unknown" as const, workspaceId };
  return { kind: bundleOwnedKind(parts), workspaceId, bundleId };
}

/** Classify the tail below one already-validated bundle directory. */
function bundleOwnedKind(parts: readonly string[]): "manifest" | "payload" | "unknown" {
  const tail = parts.slice(3);
  if (tail.length === 1 && tail[0] === "manifest.json") return "manifest";
  if (tail.length !== 2 || tail[0] !== "payloads") return "unknown";
  return SHA256.test(tail[1] ?? "") ? "payload" : "unknown";
}

/** Recognize run, cancellation, and run-evidence leaves. */
function runLeaf(workspaceId: string, parts: readonly string[]): ClassifiedLeaf | null {
  return runControlLeaf(workspaceId, parts) ?? runEvidenceLeaf(workspaceId, parts);
}

/** Recognize one authenticated run or its cancellation request. */
function runControlLeaf(workspaceId: string, parts: readonly string[]): ClassifiedLeaf | null {
  if (parts.length !== 3 || parts[1] !== "runs") return null;
  const match = /^(opr_[0-9A-HJKMNP-TV-Z]{26})\.(json|cancel)$/.exec(parts[2] ?? "");
  const runId = match === null ? null : verified(() => assertOperationRunId(match[1]));
  if (runId === null) return { kind: "unknown", workspaceId };
  return { kind: match?.[2] === "json" ? "run" : "cancel", workspaceId, runId };
}

/** Recognize one content-addressed run-evidence leaf. */
function runEvidenceLeaf(workspaceId: string, parts: readonly string[]): ClassifiedLeaf | null {
  if (parts.length !== 4 || parts[1] !== "run-evidence") return null;
  const runId = verified(() => assertOperationRunId(parts[2]));
  if (runId === null || !SHA256.test(parts[3] ?? "")) {
    return { kind: "unknown", workspaceId };
  }
  return { kind: "evidence", workspaceId, runId };
}

/** Recognize bounded recipe-owned outputs and their provenance sidecars. */
function projectionLeaf(workspaceId: string, parts: readonly string[]): ClassifiedLeaf | null {
  if (parts[1] !== "projections" || parts.length < 4) return null;
  if (verified(() => assertRecipeId(parts[2])) === null) {
    return { kind: "unknown" as const, workspaceId };
  }
  const output = parts.slice(3);
  if (output.some((part) => !PORTABLE_OUTPUT.test(part))) {
    return { kind: "unknown" as const, workspaceId };
  }
  const marker = output.at(-1)?.endsWith(PROJECTION_MARKER_SUFFIX) === true;
  return { kind: marker ? "projection-marker" as const : "projection" as const, workspaceId };
}

const LEAF_BYTE_CAPS: Partial<Record<OperationLeafKind, number>> = {
  manifest: MAX_MANIFEST_BYTES,
  payload: MAX_PAYLOAD_BYTES,
  run: MAX_RUN_BYTES,
  cancel: MAX_RUN_BYTES,
  evidence: MAX_RUN_EVIDENCE_BLOB_BYTES,
  source: MAX_RETAINED_SOURCE_BYTES,
  catalog: MAX_CATALOG_FILE_BYTES,
  projection: MAX_PROJECTION_BYTES,
  "projection-marker": MAX_PROJECTION_MARKER_BYTES,
};

/** Return the store-local inclusive cap for one recognized regular leaf. */
function leafCap(kind: OperationLeafKind): number | undefined {
  return LEAF_BYTE_CAPS[kind];
}

/** Validate only known directory topology before descending further. */
function directoryAllowed(relative: string): boolean {
  if (relative === "") return true;
  const parts = relative.split(path.sep);
  if (parts.some((part) => part.startsWith(".") && part !== ".quarantine")) return false;
  if (parts[0] === ".quarantine") return parts.slice(1).every(PORTABLE_OUTPUT.test.bind(PORTABLE_OUTPUT));
  const workspace = parts[0];
  if (verified(() => assertWorkspaceId(workspace)) === null) return false;
  if (parts.length === 1) return true;
  return operationSubdirectoryAllowed(parts);
}

/** Validate owned operation subdirectory shapes without following them. */
function operationSubdirectoryAllowed(parts: readonly string[]): boolean {
  const validators: Readonly<Record<string, (value: readonly string[]) => boolean>> = {
    bundles: bundleDirectoryAllowed,
    "run-evidence": evidenceDirectoryAllowed,
    projections: projectionDirectoryAllowed,
  };
  if (parts.length === 2) {
    return ["bundles", "runs", "run-evidence", "sources", "projections"].includes(parts[1] ?? "");
  }
  return validators[parts[1] ?? ""]?.(parts) ?? false;
}

/** Validate a bundle root or its single payload directory. */
function bundleDirectoryAllowed(parts: readonly string[]): boolean {
  if (verified(() => assertBundleId(parts[2])) === null) return false;
  return parts.length === 3 || (parts.length === 4 && parts[3] === "payloads");
}

/** Validate the run identifier owning one evidence directory. */
function evidenceDirectoryAllowed(parts: readonly string[]): boolean {
  return parts.length === 3 && verified(() => assertOperationRunId(parts[2])) !== null;
}

/** Validate a recipe output directory without accepting dot segments. */
function projectionDirectoryAllowed(parts: readonly string[]): boolean {
  if (verified(() => assertRecipeId(parts[2])) === null) return false;
  return parts.slice(3).every(PORTABLE_OUTPUT.test.bind(PORTABLE_OUTPUT));
}

/** Capture one observed regular file and its protocol-aware classification. */
async function captureLeaf(state: ScanState, file: string, parent: string): Promise<void> {
  await captureInventoryLeaf((leaf, dir, retainUpToBytes) => state.reads.observeLeaf(leaf, dir, retainUpToBytes), file, parent, {
    label: "operation",
    problem: (dimension, detail, relative) => problem(state, dimension, detail, relative),
    classify: classifyLeaf,
    // OPERATION ONLY: a dot entry inside the quarantine is flagged before the cap.
    beforeCap: (leaf) => noteQuarantineDotEntry(state, leaf),
    noteCap: (kind, bytes, leaf) => noteLeafCap(state, kind, bytes, leaf),
    record: (observation) => { state.leaves.push(observation); },
    retainUpTo: retainedLeafCap,
  });
}

/** Final leaves the inventory goes on to read: its manifests, and every leaf the authority pass re-reads. */
const RETAINED_KINDS: ReadonlySet<OperationLeafKind> = new Set<OperationLeafKind>([
  "manifest", "run", "source", "payload", "evidence", "projection", "projection-marker",
]);

/** The cap under which a final leaf the inventory goes on to read may be kept; no other leaf is. */
function retainedLeafCap(classified: ClassifiedLeaf): number | undefined {
  if (classified.protocolAlias !== undefined || !RETAINED_KINDS.has(classified.kind)) return undefined;
  return leafCap(classified.kind);
}

/** Mark hidden quarantine state while retaining its visible capacity bytes. */
function noteQuarantineDotEntry(state: ScanState, file: string): void {
  const parts = file.split(path.sep);
  if (parts[0] === ".quarantine" && parts.slice(1).some((part) => part.startsWith("."))) {
    problem(state, "operation-entry", "dot entry inside operation quarantine", file);
  }
}

/** Refuse a recognized leaf whose metadata already exceeds its local cap. */
function noteLeafCap(state: ScanState, kind: OperationLeafKind, bytes: number, file: string): void {
  const cap = leafCap(kind);
  if (cap !== undefined && bytes > cap) {
    problem(state, `${kind}-bytes`, "operation leaf exceeds its byte cap", file);
  }
}


/** Track verified workspace and bundle directory identities for orphan logic. */
function captureDirectoryIdentity(state: ScanState, relative: string): void {
  const parts = relative.split(path.sep);
  if (parts.length === 1 && parts[0] !== ".quarantine") state.workspaces.add(parts[0]!);
  if (parts.length !== 3 || parts[1] !== "bundles") return;
  const workspaceId = verified(() => assertWorkspaceId(parts[0]));
  const bundleId = verified(() => assertBundleId(parts[2]));
  if (workspaceId !== null && bundleId !== null) {
    state.bundleDirectories.set(`${workspaceId}\0${bundleId}`, { workspaceId, bundleId });
  }
}

/** Consume one unit from the global traversal bound. */
function takeEntry(state: ScanState, dir: string): boolean {
  state.entries += 1;
  if (state.entries <= state.maxEntries) return true;
  state.exhausted = true;
  problem(state, "directory-entries", "operation inventory entry bound exceeded", dir);
  return false;
}

/** Inspect one directory entry without duplicating topology decisions. */
async function inspectEntry(
  state: ScanState,
  entry: OperationStoreEntry,
  dir: string,
  depth: number,
): Promise<void> {
  const child = path.join(dir, entry.name), relative = child;
  state.listed.entries.add(child);
  if (entry.isDirectory()) {
    if (isForeignStoreDirectory(relative)) return; // preparation store owns this; not operation inventory
    if (!directoryAllowed(relative)) {
      problem(state, relative.startsWith(".") ? "workspace-entry" : "operation-entry",
        "unknown operation directory", child);
      return;
    }
    captureDirectoryIdentity(state, relative);
    await walk(state, child, depth + 1);
    return;
  }
  if (entry.isFile() || entry.isSymbolicLink()) {
    await captureLeaf(state, child, dir);
    return;
  }
  problem(state, "operation-entry", "unsupported operation entry", child);
}

/** Traverse until the global entry bound is reached, then fail closed. */
async function walk(state: ScanState, dir: string, depth: number): Promise<void> {
  await walkInventoryTree(state, dir, depth, { label: "operation", maxDepth: MAX_SCAN_DEPTH, problem, takeEntry, inspectEntry });
}

/**
 * The local-disk walk reads for one project root. Built per call and PURE to
 * build (two lexical resolutions, no I/O): each closure joins the
 * workspaces-relative path back under the resolved store root and calls the
 * shared confined primitive with the resolved project root. In no package index.
 */
export function diskOperationStoreWalkReads(root: string, scanned?: ScannedLeafBytes): OperationStoreWalkReads {
  return diskInventoryWalkReads(root, path.join(".llmwiki", "workspaces"), scanned);
}

/**
 * Inventory every operation-store leaf without creating any path. A pass that
 * goes on to read the leaves hands in its `scanned` holder, so the walk's reads
 * of them are the ones its readers consume.
 */
export async function scanOperationOrphans(
  root: string,
  options: OperationScanOptions = {},
  scanned?: ScannedLeafBytes,
): Promise<OperationOrphanScan> {
  return scanOperationOrphansFrom(diskOperationStoreWalkReads(root, scanned), options);
}

/** The walk reads, noting each directory whose listing completed. */
function listingReads(reads: OperationStoreWalkReads, directories: Set<string>): OperationStoreWalkReads {
  return {
    observeLeaf: reads.observeLeaf,
    visitDirectory: async (directory, visitor) => {
      const visit = await reads.visitDirectory(directory, visitor);
      if (visit === "visited") directories.add(directory);
      return visit;
    },
  };
}

/** {@link scanOperationOrphans} over the scanner's own reads: the one walk body. */
export async function scanOperationOrphansFrom(
  reads: OperationStoreWalkReads,
  options: OperationScanOptions = {},
): Promise<OperationOrphanScan> {
  const requested = positiveScanEntryLimit(options.maxDirectoryEntriesForTest ?? DEFAULT_MAX_ENTRIES, "operation");
  const listed = { directories: new Set<string>(), entries: new Set<string>() };
  const state: ScanState = {
    reads: listingReads(reads, listed.directories), listed, maxEntries: requested, entries: 0, exhausted: false, leaves: [],
    workspaces: new Set(), bundleDirectories: new Map(), problems: [],
  };
  await walk(state, "", 0);
  return {
    listing: listed,
    leaves: state.leaves,
    workspaces: [...state.workspaces].sort(),
    bundleDirectories: [...state.bundleDirectories.values()]
      .sort((left, right) => `${left.workspaceId}/${left.bundleId}`.localeCompare(`${right.workspaceId}/${right.bundleId}`)),
    problems: state.problems,
  };
}

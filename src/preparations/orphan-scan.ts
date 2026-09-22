/**
 * @file src/preparations/orphan-scan.ts
 * @description Bounded, no-follow traversal of the complete preparation store
 * (design sections 8.4, 26.2, 26.4). The scanner descends ONLY the preparation
 * roots. Capacity uses the active-store entry point; destructive planning alone
 * retains the active-plus-quarantine compatibility entry point until Tasks
 * 9D/9E. Co-located Milestone A subtrees are a different store's namespace and
 * are ignored rather than mis-counted as orphans. Every unknown or unreadable
 * leg is reported instead of silently omitted.
 */

import path from "node:path";
import { noteInventoryProblem as problem, durableAlias, verified, walkInventoryDirectory, openInventoryLeaf, recordInventoryLeaf, positiveScanEntryLimit } from "../utils/inventory-scan.js";
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

interface ScanState {
  root: string;
  llmwikiRoot: string;
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
  const opened = await openInventoryLeaf(state, file, parent, "preparation");
  if (opened === null) return;
  const relativePath = path.relative(state.llmwikiRoot, file);
  const classified = classifyLeaf(relativePath);
  noteLeafCap(state, classified.kind, opened.size, file);
  await recordInventoryLeaf(state.leaves, classified, relativePath, opened);
  if (classified.kind === "unknown") problem(state, "preparation-entry", "unknown preparation leaf", file);
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
async function inspectEntry(state: ScanState, entry: { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }, dir: string, depth: number): Promise<void> {
  const child = path.join(dir, entry.name), relative = path.relative(state.llmwikiRoot, child);
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
  if (state.exhausted) return;
  if (depth > MAX_SCAN_DEPTH) {
    problem(state, "directory-depth", "preparation inventory depth exceeded", dir);
    state.exhausted = true;
    return;
  }
  await walkInventoryDirectory(state, { directory: dir, store: "preparation" }, {
    take: () => !state.exhausted && takeEntry(state, dir),
    inspect: (entry) => inspectEntry(state, entry, dir, depth),
  });
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
  root: string,
  options: PreparationScanOptions,
): ScanState {
  const llmwikiRoot = path.join(root, ".llmwiki");
  return {
    root: path.resolve(root), llmwikiRoot: path.resolve(llmwikiRoot),
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

/** Inventory active preparation storage without entering a lifecycle registry. */
export async function scanActivePreparationStore(
  root: string,
  options: PreparationScanOptions = {},
): Promise<PreparationOrphanScan> {
  const state = scanState(root, options);
  await walk(state, path.join(state.llmwikiRoot, "workspaces"), 0);
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
  const state = scanState(root, options);
  await walk(state, path.join(state.llmwikiRoot, "workspaces"), 0);
  await walk(state, path.join(state.llmwikiRoot, PREPARATION_QUARANTINE_SEGMENT), 0);
  return scanResult(state);
}

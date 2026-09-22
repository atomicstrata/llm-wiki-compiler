/**
 * @file src/operation-bundles/orphan-scan.ts
 * @description Bounded, no-follow traversal of the complete operation store.
 * The scanner classifies protocol-owned durable aliases explicitly and reports
 * every unknown or unreadable leg instead of silently omitting capacity.
 */

import path from "node:path";
import type { Dirent } from "node:fs";
import { noteInventoryProblem as problem, durableAlias, verified, walkInventoryDirectory, openInventoryLeaf, recordInventoryLeaf, positiveScanEntryLimit } from "../utils/inventory-scan.js";
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
}

/** Test-only lower bound for deterministic directory-exhaustion coverage. */
export interface OperationScanOptions {
  maxDirectoryEntriesForTest?: number;
}

interface ScanState {
  root: string;
  workspacesRoot: string;
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

/** Capture one opened regular file and its protocol-aware classification. */
async function captureLeaf(state: ScanState, file: string, parent: string): Promise<void> {
  const opened = await openInventoryLeaf(state, file, parent, "operation");
  if (opened === null) return;
  const relativePath = path.relative(state.workspacesRoot, file);
  const classified = classifyLeaf(relativePath);
  noteQuarantineDotEntry(state, relativePath, file);
  noteLeafCap(state, classified.kind, opened.size, file);
  await recordInventoryLeaf(state.leaves, classified, relativePath, opened);
  if (classified.kind === "unknown") problem(state, "operation-entry", "unknown operation leaf", file);
}

/** Mark hidden quarantine state while retaining its visible capacity bytes. */
function noteQuarantineDotEntry(state: ScanState, relative: string, file: string): void {
  const parts = relative.split(path.sep);
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
  entry: Dirent,
  dir: string,
  depth: number,
): Promise<void> {
  const child = path.join(dir, entry.name), relative = path.relative(state.workspacesRoot, child);
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
  if (state.exhausted) return;
  if (depth > MAX_SCAN_DEPTH) {
    problem(state, "directory-depth", "operation inventory depth exceeded", dir);
    state.exhausted = true;
    return;
  }
  await walkInventoryDirectory(state, { directory: dir, store: "operation" }, {
    take: () => !state.exhausted && takeEntry(state, dir),
    inspect: (entry) => inspectEntry(state, entry, dir, depth),
  });
}

/** Inventory every operation-store leaf without creating any path. */
export async function scanOperationOrphans(
  root: string,
  options: OperationScanOptions = {},
): Promise<OperationOrphanScan> {
  const workspacesRoot = path.join(root, ".llmwiki", "workspaces");
  const requested = positiveScanEntryLimit(options.maxDirectoryEntriesForTest ?? DEFAULT_MAX_ENTRIES, "operation");
  const state: ScanState = {
    root: path.resolve(root), workspacesRoot: path.resolve(workspacesRoot),
    maxEntries: requested, entries: 0, exhausted: false, leaves: [],
    workspaces: new Set(), bundleDirectories: new Map(), problems: [],
  };
  await walk(state, state.workspacesRoot, 0);
  return {
    leaves: state.leaves,
    workspaces: [...state.workspaces].sort(),
    bundleDirectories: [...state.bundleDirectories.values()]
      .sort((left, right) => `${left.workspaceId}/${left.bundleId}`.localeCompare(`${right.workspaceId}/${right.bundleId}`)),
    problems: state.problems,
  };
}

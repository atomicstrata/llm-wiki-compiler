/**
 * @file src/operation-bundles/inventory-authority.ts
 * @description Authoritative content verification for staging inventory:
 * retained sources, projections, bundle payloads, run evidence, and run
 * records (including orphans) are re-read through their owned roots and
 * authenticated before their bytes count as healthy. Filenames and directory
 * metadata alone never establish valid store state, and a run record must
 * verify under the exact identity of the path it occupies.
 *
 * ONE VERIFICATION BODY. `verifyInventoryAuthoritiesFrom` owns every rehash,
 * pairing, authentication and problem over {@link InventoryAuthorityReads}: one
 * capped leaf read by logical location, and the key. The root form delegates over
 * {@link diskInventoryAuthorityReads}, which derives each confined path and calls
 * the incumbent durable-leaf read; identity validation stays in the body, in the
 * incumbent order.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import pLimit from "p-limit";
import {
  MAX_PAYLOAD_BYTES, MAX_PROJECTION_BYTES, MAX_RETAINED_SOURCE_BYTES,
  MAX_RUN_BYTES, MAX_RUN_EVIDENCE_BLOB_BYTES,
} from "./constants.js";
import type { CappedLeafReadBuffer } from "../utils/confined-read.js";
import { readDurableOperationLeafBuffer } from "./durable-leaf.js";
import { assertBundleId, assertOperationRunId, type BundleId, type OperationRunId } from "./ids.js";
import { readOperationKey, type OperationKeyRead } from "./key-epoch.js";
import type {
  OperationInventoryProblem, OperationLeafObservation,
} from "./orphan-scan.js";
import { assertWorkspaceId, operationPaths, PROJECTION_MARKER_SUFFIX } from "./paths.js";
import {
  parseProjectionMarker, type ProjectionMarker,
} from "./projection-store.js";
import {
  operationRunBinding, verifyOperationRunIntegrity,
} from "./run-integrity.js";
import { parseOperationRun } from "./run-parse.js";

const MAX_MARKER_BYTES = 4 * 1024;

/** One authoritative leaf, named by its logical location rather than a path. */
export type InventoryAuthorityLeaf =
  | { kind: "source"; workspaceId: string; digest: string }
  | { kind: "payload"; workspaceId: string; bundleId: BundleId; digest: string }
  | { kind: "evidence"; workspaceId: string; runId: OperationRunId; digest: string }
  | { kind: "run"; workspaceId: string; runId: OperationRunId }
  | { kind: "projection-output" | "projection-marker"; workspaceId: string; recipeId: string; relativeOutputPath: string };

/** What the authority verification asks of the store. No member takes a project root. */
export interface InventoryAuthorityReads {
  /** One leaf's bytes within `maxBytes`; a location whose path cannot be derived throws. */
  readLeaf(leaf: InventoryAuthorityLeaf, maxBytes: number): Promise<CappedLeafReadBuffer>;
  /** The operation key WITH ITS BYTES. Local: `readOperationKey(root)`. */
  readKey(): Promise<OperationKeyRead>;
}

/** The confined final path and owned parent of one authoritative location. */
function authorityLeafPaths(root: string, leaf: InventoryAuthorityLeaf): { file: string; parent: string } {
  const paths = operationPaths(root, leaf.workspaceId);
  switch (leaf.kind) {
    case "source": return { file: paths.sourceFile(leaf.digest), parent: paths.sourcesRoot };
    case "payload": return { file: paths.payloadFile(leaf.bundleId, leaf.digest), parent: paths.payloadsRoot(leaf.bundleId) };
    case "evidence": return { file: paths.evidenceFile(leaf.runId, leaf.digest), parent: paths.evidenceRoot(leaf.runId) };
    case "run": return { file: paths.runFile(leaf.runId), parent: paths.runsRoot };
    default: {
      const output = path.join(paths.projectionRoot(leaf.recipeId), ...leaf.relativeOutputPath.split("/"));
      const file = leaf.kind === "projection-marker" ? `${output}${PROJECTION_MARKER_SUFFIX}` : output;
      return { file, parent: path.dirname(output) };
    }
  }
}

/** The local-disk authority reads for one root, built per call. In no package index. */
function diskInventoryAuthorityReads(root: string): InventoryAuthorityReads {
  return {
    readLeaf: (leaf, maxBytes) => {
      const { file, parent } = authorityLeafPaths(root, leaf);
      return readDurableOperationLeafBuffer(root, file, parent, maxBytes);
    },
    readKey: () => readOperationKey(root),
  };
}

/** Return a prefixed digest for exact authoritative bytes. */
function digest(bytes: Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * How many leaf reads one verification pass keeps in flight. Each leaf is read
 * and rehashed independently, so a store of many leaves is verified in a
 * fraction of the time a one-at-a-time walk takes.
 */
const VERIFY_READ_CONCURRENCY = 16;

/**
 * Check every leaf and report each failure's detail under `dimension`, in leaf
 * order. `check` resolves to the detail of what is wrong, or undefined.
 */
async function reportInvalid<T>(
  items: readonly T[], dimension: OperationInventoryProblem["dimension"], problems: OperationInventoryProblem[],
  check: (item: T) => Promise<string | undefined>,
): Promise<void> {
  const limit = pLimit(VERIFY_READ_CONCURRENCY);
  const details = await Promise.all(items.map((item) => limit(() => check(item))));
  for (const detail of details) if (detail !== undefined) problems.push({ dimension, detail });
}

/** Rehash every final retained source against its content-address filename. */
async function verifySources(
  reads: InventoryAuthorityReads,
  leaves: readonly OperationLeafObservation[],
  problems: OperationInventoryProblem[],
): Promise<void> {
  await reportInvalid(finalLeaves(leaves, "source"), "source-state", problems, async (leaf) => {
    const expected = path.basename(leaf.logicalRelativePath);
    const read = await reads.readLeaf({ kind: "source", workspaceId: leaf.workspaceId!, digest: expected }, MAX_RETAINED_SOURCE_BYTES);
    return read.kind === "ok" && digest(read.body) === `sha256:${expected}` ? undefined : "retained source is unavailable or invalid";
  });
}

/** Return the logical pair key for one projection output or sidecar. */
function projectionKey(leaf: OperationLeafObservation): string {
  const relative = leaf.logicalRelativePath;
  return leaf.kind === "projection-marker"
    ? relative.slice(0, -PROJECTION_MARKER_SUFFIX.length) : relative;
}

/** Match parsed marker authority to the path-derived output and exact bytes. */
function markerMatches(
  marker: ProjectionMarker,
  recipeId: string,
  relativeOutputPath: string,
  bytes: Buffer,
): boolean {
  if (marker.recipeId !== recipeId || marker.relativeOutputPath !== relativeOutputPath) return false;
  if (marker.byteCount !== bytes.byteLength) return false;
  return marker.outputDigest === digest(bytes);
}

/** Verify one output and marker pair against its path-derived ownership. */
async function verifyProjectionPair(
  reads: InventoryAuthorityReads,
  output: OperationLeafObservation,
  marker: OperationLeafObservation,
): Promise<boolean> {
  if (output.workspaceId === undefined || marker.workspaceId !== output.workspaceId) return false;
  const parts = projectionKey(output).split(path.sep);
  const recipeId = parts[2], relativeOutputPath = parts.slice(3).join("/");
  if (recipeId === undefined || relativeOutputPath === "") return false;
  const location = { workspaceId: output.workspaceId, recipeId, relativeOutputPath };
  const [outputRead, markerRead] = await Promise.all([
    reads.readLeaf({ kind: "projection-output", ...location }, MAX_PROJECTION_BYTES),
    reads.readLeaf({ kind: "projection-marker", ...location }, MAX_MARKER_BYTES),
  ]);
  if (outputRead.kind !== "ok" || markerRead.kind !== "ok") return false;
  try {
    const authority = parseProjectionMarker(markerRead.body);
    return markerMatches(authority, recipeId, relativeOutputPath, outputRead.body);
  } catch {
    return false;
  }
}

/** Require a one-to-one authoritative output/marker pairing for every projection. */
async function verifyProjections(
  reads: InventoryAuthorityReads,
  leaves: readonly OperationLeafObservation[],
  problems: OperationInventoryProblem[],
): Promise<void> {
  const owned = leaves.filter((leaf) =>
    (leaf.kind === "projection" || leaf.kind === "projection-marker") && leaf.protocolAlias === undefined);
  const grouped = new Map<string, OperationLeafObservation[]>();
  for (const leaf of owned) grouped.set(projectionKey(leaf), [...(grouped.get(projectionKey(leaf)) ?? []), leaf]);
  await reportInvalid([...grouped.values()], "projection-state", problems, async (values) => {
    const output = values.find((leaf) => leaf.kind === "projection");
    const marker = values.find((leaf) => leaf.kind === "projection-marker");
    return output !== undefined && marker !== undefined && await verifyProjectionPair(reads, output, marker)
      ? undefined : "projection output or marker is unavailable or invalid";
  });
}

/** Select final (non-alias) leaves of one kind with complete identities. */
function finalLeaves(
  leaves: readonly OperationLeafObservation[],
  kind: OperationLeafObservation["kind"],
): OperationLeafObservation[] {
  return leaves.filter((leaf) =>
    leaf.kind === kind && leaf.protocolAlias === undefined && leaf.workspaceId !== undefined);
}

/** Rehash every final bundle payload against its content-address filename. */
async function verifyPayloadLeaves(
  reads: InventoryAuthorityReads,
  leaves: readonly OperationLeafObservation[],
  problems: OperationInventoryProblem[],
): Promise<void> {
  await reportInvalid(finalLeaves(leaves, "payload"), "payload-state", problems, async (leaf) => {
    if (leaf.bundleId === undefined) return "bundle payload leaf is missing its identity";
    const expected = path.basename(leaf.logicalRelativePath);
    const workspaceId = assertWorkspaceId(leaf.workspaceId!), bundleId = assertBundleId(leaf.bundleId);
    const read = await reads.readLeaf({ kind: "payload", workspaceId, bundleId, digest: expected }, MAX_PAYLOAD_BYTES);
    return read.kind === "ok" && digest(read.body) === `sha256:${expected}` ? undefined : "bundle payload is unavailable or invalid";
  });
}

/** Rehash every final run-evidence blob against its content-address filename. */
async function verifyEvidenceLeaves(
  reads: InventoryAuthorityReads,
  leaves: readonly OperationLeafObservation[],
  problems: OperationInventoryProblem[],
): Promise<void> {
  await reportInvalid(finalLeaves(leaves, "evidence"), "evidence-state", problems, async (leaf) => {
    if (leaf.runId === undefined) return "run evidence leaf is missing its identity";
    const expected = path.basename(leaf.logicalRelativePath);
    const workspaceId = assertWorkspaceId(leaf.workspaceId!), runId = assertOperationRunId(leaf.runId);
    const read = await reads.readLeaf({ kind: "evidence", workspaceId, runId, digest: expected }, MAX_RUN_EVIDENCE_BLOB_BYTES);
    return read.kind === "ok" && digest(read.body) === `sha256:${expected}` ? undefined : "run evidence is unavailable or invalid";
  });
}

/**
 * Authenticate every final run record, including orphans. Manifest binding is
 * checked later where a manifest exists; here the record must parse
 * exact-shape, carry a valid HMAC under the project key, and record the exact
 * run and workspace identity of the path it was found at, so neither a corrupt
 * nor a relocated authentic run leaf can be counted as a healthy record.
 */
async function verifyRunLeaves(
  reads: InventoryAuthorityReads,
  leaves: readonly OperationLeafObservation[],
  problems: OperationInventoryProblem[],
): Promise<void> {
  const runLeaves = finalLeaves(leaves, "run");
  if (runLeaves.length === 0) return;
  const key = await reads.readKey();
  await reportInvalid(runLeaves, "run-state", problems, async (leaf) => {
    if (leaf.runId === undefined) return "operation run leaf is missing its identity";
    const workspaceId = assertWorkspaceId(leaf.workspaceId!), runId = assertOperationRunId(leaf.runId);
    const read = await reads.readLeaf({ kind: "run", workspaceId, runId }, MAX_RUN_BYTES);
    return read.kind === "ok" && key.status === "ok" && runRecordAuthentic(read.body, key.key, leaf.runId, leaf.workspaceId!)
      ? undefined : "operation run record is unavailable or invalid";
  });
}

/** Prove one run record verifies under its path-derived storage identity. */
function runRecordAuthentic(
  body: Buffer, key: Buffer, runId: string, workspaceId: string,
): boolean {
  try {
    const run = parseOperationRun(body.toString("utf8"));
    const binding = {
      ...operationRunBinding(run), runId: assertOperationRunId(runId), workspaceId,
    };
    return verifyOperationRunIntegrity(run, key, binding);
  } catch {
    return false;
  }
}

/** Verify founding-store leaves before their bytes contribute healthy capacity. */
export async function verifyInventoryAuthorities(
  root: string,
  leaves: readonly OperationLeafObservation[],
  problems: OperationInventoryProblem[],
): Promise<void> {
  await verifyInventoryAuthoritiesFrom(diskInventoryAuthorityReads(root), leaves, problems);
}

/** {@link verifyInventoryAuthorities} over the authority reads: the one body, in the incumbent store order. */
export async function verifyInventoryAuthoritiesFrom(
  reads: InventoryAuthorityReads,
  leaves: readonly OperationLeafObservation[],
  problems: OperationInventoryProblem[],
): Promise<void> {
  await verifySources(reads, leaves, problems);
  await verifyProjections(reads, leaves, problems);
  await verifyPayloadLeaves(reads, leaves, problems);
  await verifyEvidenceLeaves(reads, leaves, problems);
  await verifyRunLeaves(reads, leaves, problems);
}

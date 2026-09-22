/**
 * @file src/operation-bundles/inventory-authority.ts
 * @description Authoritative content verification for staging inventory:
 * retained sources, projections, bundle payloads, run evidence, and run
 * records (including orphans) are re-read through their owned roots and
 * authenticated before their bytes count as healthy. Filenames and directory
 * metadata alone never establish valid store state, and a run record must
 * verify under the exact identity of the path it occupies.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import {
  MAX_PAYLOAD_BYTES, MAX_PROJECTION_BYTES, MAX_RETAINED_SOURCE_BYTES,
  MAX_RUN_BYTES, MAX_RUN_EVIDENCE_BLOB_BYTES,
} from "./constants.js";
import { readDurableOperationLeafBuffer } from "./durable-leaf.js";
import { assertBundleId, assertOperationRunId } from "./ids.js";
import { readOperationKey } from "./key-epoch.js";
import type {
  OperationInventoryProblem, OperationLeafObservation,
} from "./orphan-scan.js";
import { operationPaths, PROJECTION_MARKER_SUFFIX } from "./paths.js";
import {
  parseProjectionMarker, type ProjectionMarker,
} from "./projection-store.js";
import {
  operationRunBinding, verifyOperationRunIntegrity,
} from "./run-integrity.js";
import { parseOperationRun } from "./run-parse.js";

const MAX_MARKER_BYTES = 4 * 1024;

/** Return a prefixed digest for exact authoritative bytes. */
function digest(bytes: Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Rehash every final retained source against its content-address filename. */
async function verifySources(
  root: string,
  leaves: readonly OperationLeafObservation[],
  problems: OperationInventoryProblem[],
): Promise<void> {
  for (const leaf of leaves) {
    if (leaf.kind !== "source" || leaf.protocolAlias !== undefined || leaf.workspaceId === undefined) continue;
    const expected = path.basename(leaf.logicalRelativePath);
    const paths = operationPaths(root, leaf.workspaceId);
    const read = await readDurableOperationLeafBuffer(
      root, paths.sourceFile(expected), paths.sourcesRoot, MAX_RETAINED_SOURCE_BYTES,
    );
    if (read.kind !== "ok" || digest(read.body) !== `sha256:${expected}`) {
      problems.push({ dimension: "source-state", detail: "retained source is unavailable or invalid" });
    }
  }
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
  root: string,
  output: OperationLeafObservation,
  marker: OperationLeafObservation,
): Promise<boolean> {
  if (output.workspaceId === undefined || marker.workspaceId !== output.workspaceId) return false;
  const parts = projectionKey(output).split(path.sep);
  const recipeId = parts[2], relativeOutputPath = parts.slice(3).join("/");
  if (recipeId === undefined || relativeOutputPath === "") return false;
  const paths = operationPaths(root, output.workspaceId);
  const outputFile = path.join(paths.projectionRoot(recipeId), ...relativeOutputPath.split("/"));
  const parent = path.dirname(outputFile);
  const [outputRead, markerRead] = await Promise.all([
    readDurableOperationLeafBuffer(root, outputFile, parent, MAX_PROJECTION_BYTES),
    readDurableOperationLeafBuffer(root, `${outputFile}${PROJECTION_MARKER_SUFFIX}`, parent, MAX_MARKER_BYTES),
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
  root: string,
  leaves: readonly OperationLeafObservation[],
  problems: OperationInventoryProblem[],
): Promise<void> {
  const owned = leaves.filter((leaf) =>
    (leaf.kind === "projection" || leaf.kind === "projection-marker") && leaf.protocolAlias === undefined);
  const grouped = new Map<string, OperationLeafObservation[]>();
  for (const leaf of owned) grouped.set(projectionKey(leaf), [...(grouped.get(projectionKey(leaf)) ?? []), leaf]);
  for (const values of grouped.values()) {
    const output = values.find((leaf) => leaf.kind === "projection");
    const marker = values.find((leaf) => leaf.kind === "projection-marker");
    if (output === undefined || marker === undefined || !(await verifyProjectionPair(root, output, marker))) {
      problems.push({ dimension: "projection-state", detail: "projection output or marker is unavailable or invalid" });
    }
  }
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
  root: string,
  leaves: readonly OperationLeafObservation[],
  problems: OperationInventoryProblem[],
): Promise<void> {
  for (const leaf of finalLeaves(leaves, "payload")) {
    if (leaf.bundleId === undefined) {
      problems.push({ dimension: "payload-state", detail: "bundle payload leaf is missing its identity" });
      continue;
    }
    const expected = path.basename(leaf.logicalRelativePath);
    const paths = operationPaths(root, leaf.workspaceId!);
    const bundleId = assertBundleId(leaf.bundleId);
    const read = await readDurableOperationLeafBuffer(
      root, paths.payloadFile(bundleId, expected), paths.payloadsRoot(bundleId), MAX_PAYLOAD_BYTES,
    );
    if (read.kind !== "ok" || digest(read.body) !== `sha256:${expected}`) {
      problems.push({ dimension: "payload-state", detail: "bundle payload is unavailable or invalid" });
    }
  }
}

/** Rehash every final run-evidence blob against its content-address filename. */
async function verifyEvidenceLeaves(
  root: string,
  leaves: readonly OperationLeafObservation[],
  problems: OperationInventoryProblem[],
): Promise<void> {
  for (const leaf of finalLeaves(leaves, "evidence")) {
    if (leaf.runId === undefined) {
      problems.push({ dimension: "evidence-state", detail: "run evidence leaf is missing its identity" });
      continue;
    }
    const expected = path.basename(leaf.logicalRelativePath);
    const paths = operationPaths(root, leaf.workspaceId!);
    const runId = assertOperationRunId(leaf.runId);
    const read = await readDurableOperationLeafBuffer(
      root, paths.evidenceFile(runId, expected), paths.evidenceRoot(runId), MAX_RUN_EVIDENCE_BLOB_BYTES,
    );
    if (read.kind !== "ok" || digest(read.body) !== `sha256:${expected}`) {
      problems.push({ dimension: "evidence-state", detail: "run evidence is unavailable or invalid" });
    }
  }
}

/**
 * Authenticate every final run record, including orphans. Manifest binding is
 * checked later where a manifest exists; here the record must parse
 * exact-shape, carry a valid HMAC under the project key, and record the exact
 * run and workspace identity of the path it was found at, so neither a corrupt
 * nor a relocated authentic run leaf can be counted as a healthy record.
 */
async function verifyRunLeaves(
  root: string,
  leaves: readonly OperationLeafObservation[],
  problems: OperationInventoryProblem[],
): Promise<void> {
  const runLeaves = finalLeaves(leaves, "run");
  if (runLeaves.length === 0) return;
  const key = await readOperationKey(root);
  for (const leaf of runLeaves) {
    if (leaf.runId === undefined) {
      problems.push({ dimension: "run-state", detail: "operation run leaf is missing its identity" });
      continue;
    }
    const paths = operationPaths(root, leaf.workspaceId!);
    const read = await readDurableOperationLeafBuffer(
      root, paths.runFile(assertOperationRunId(leaf.runId)), paths.runsRoot, MAX_RUN_BYTES,
    );
    if (read.kind !== "ok" || key.status !== "ok"
      || !runRecordAuthentic(read.body, key.key, leaf.runId, leaf.workspaceId!)) {
      problems.push({ dimension: "run-state", detail: "operation run record is unavailable or invalid" });
    }
  }
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
  await verifySources(root, leaves, problems);
  await verifyProjections(root, leaves, problems);
  await verifyPayloadLeaves(root, leaves, problems);
  await verifyEvidenceLeaves(root, leaves, problems);
  await verifyRunLeaves(root, leaves, problems);
}

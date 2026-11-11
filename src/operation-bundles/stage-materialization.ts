/**
 * @file src/operation-bundles/stage-materialization.ts
 * @description Exact read-only classification of candidate bundle material.
 * It distinguishes a fully authenticated replay from recoverable payload- or
 * manifest-only durable prefixes before capacity arithmetic or publication.
 *
 * ONE CLASSIFICATION BODY. `inspectStageMaterializationWith` decides order,
 * identity conflicts and the byte delta over ONE collaborator that inspects a
 * reserved candidate leaf (final, `.tmp`, `.writing`) named by its logical
 * location; the local-disk factory maps each location to its confined path and
 * calls the incumbent `inspectDurableCandidate`. The body takes ONE grouped
 * request and is exported so a direct in-memory witness can drive it without the
 * root form; it is in no package index. Its two identity steps are named:
 * {@link assertBundleIdentity} before any read, {@link inspectRunCandidate} after
 * the payload and manifest inspections.
 */

import {
  MAX_MANIFEST_BYTES, MAX_PAYLOAD_BYTES, MAX_RUN_BYTES,
} from "./constants.js";
import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import type { OperationInventory } from "./capacity.js";
import path from "node:path";
import { durableTempPath, durableWritingPath } from "../utils/atomic-write-no-replace-durable.js";
import { inspectDurableCandidate, type DurableCandidateInspection } from "./durable-candidate.js";
import { walkProvesAbsent } from "./orphan-scan.js";
import type { BundleId, OperationRunId } from "./ids.js";
import { assertWorkspaceId, operationPaths } from "./paths.js";
import type { OperationBundleManifest } from "./types.js";

/** Candidate components still requiring one durable publication transition. */
export interface StageMaterialization {
  complete: boolean;
  missingManifest: boolean;
  missingRun: boolean;
  missingPayloads: ReadonlySet<string>;
  physicalActiveByteDelta: number;
  settled: boolean;
}

/** One reserved candidate leaf, named by its logical location rather than a path. */
export type StageCandidateLeaf =
  | { kind: "payload"; workspaceId: string; bundleId: BundleId; digest: string }
  | { kind: "manifest"; workspaceId: string; bundleId: BundleId }
  | { kind: "run"; workspaceId: string; runId: OperationRunId };

/** What the materialization classifier asks of the store. No member takes a project root. */
export interface StageMaterializationReads {
  /** Inspect one candidate's final, ready and scratch leaves against `expected`; a conflict rejects with `conflict`. */
  inspectCandidate(
    leaf: StageCandidateLeaf, expected: Buffer, maxBytes: number, conflict: string, mode?: number,
  ): ReturnType<typeof inspectDurableCandidate>;
}

/** The confined final path and owned parent of one candidate location, and the store root the walk lists. */
function candidatePaths(root: string, leaf: StageCandidateLeaf): { file: string; parent: string; store: string } {
  const paths = operationPaths(root, leaf.workspaceId), store = paths.workspacesRoot;
  if (leaf.kind === "payload") return { file: paths.payloadFile(leaf.bundleId, leaf.digest), parent: paths.payloadsRoot(leaf.bundleId), store };
  if (leaf.kind === "manifest") return { file: paths.manifestFile(leaf.bundleId), parent: paths.bundleRoot(leaf.bundleId), store };
  return { file: paths.runFile(leaf.runId), parent: paths.runsRoot, store };
}

/** A candidate with no final, ready or scratch leaf: publish all of it, nothing to credit. */
function absentCandidate(expected: Buffer): DurableCandidateInspection {
  return { authoritative: false, publicationRequired: true, physicalByteDelta: expected.byteLength };
}

/**
 * The local-disk classifier reads for one root, built per call. In no package
 * index. When the stage's own problem-free walk listed the candidate's directory
 * (or the nearest existing ancestor of it) and found none of its three reserved
 * leaves, they are absent: the walk and this classification are one read-only
 * preflight under one hold of the lock (`stage.ts`), so a second lookup would
 * only re-ask the walk. Any other candidate is inspected on disk as before.
 */
function diskStageMaterializationReads(root: string, listing: OperationInventory["listing"]): StageMaterializationReads {
  return {
    inspectCandidate: async (leaf, expected, maxBytes, conflict, mode) => {
      const { file, parent, store } = candidatePaths(root, leaf);
      if (listing !== undefined && walkProvesAbsent(listing, reservedLeaves(path.relative(store, file)))) return absentCandidate(expected);
      return inspectDurableCandidate(root, file, parent, expected, maxBytes, conflict, mode);
    },
  };
}

/** One candidate's final, ready and scratch paths. */
function reservedLeaves(file: string): string[] {
  return [file, durableTempPath(file), durableWritingPath(file)];
}

/** Inspect every intended payload path in deterministic publication order. */
async function inspectPayloads(
  reads: StageMaterializationReads,
  manifest: OperationBundleManifest,
  payloads: ReadonlyMap<string, Buffer>,
): Promise<{ required: Set<string>; byteDelta: number }> {
  const required = new Set<string>();
  let byteDelta = 0;
  for (const [digest, expected] of [...payloads.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const inspected = await reads.inspectCandidate(
      { kind: "payload", workspaceId: manifest.workspaceId, bundleId: manifest.bundleId, digest },
      expected, MAX_PAYLOAD_BYTES, "operation bundle payload identity conflict",
    );
    if (inspected.publicationRequired) required.add(digest);
    byteDelta += inspected.physicalByteDelta;
  }
  return { required, byteDelta };
}

/** Classify exact existing state and reject every identity collision. */
export async function inspectStageMaterialization(
  root: string,
  manifest: OperationBundleManifest,
  manifestBytes: Buffer,
  payloads: ReadonlyMap<string, Buffer>,
  inventory: OperationInventory,
  runBytes: Buffer | undefined,
): Promise<StageMaterialization> {
  return inspectStageMaterializationWith(diskStageMaterializationReads(root, inventory.listing), { manifest, manifestBytes, payloads, inventory, runBytes });
}

/** One classification request: the bundle's manifest and canonical bytes, its payloads, the inventory, and the run's bytes when staged with it. */
interface StageMaterializationRequest {
  manifest: OperationBundleManifest;
  manifestBytes: Buffer;
  payloads: ReadonlyMap<string, Buffer>;
  inventory: OperationInventory;
  runBytes: Buffer | undefined;
}

/** Before any read: an inventoried bundle of the same id must have these exact canonical bytes, then the workspace must be safe. */
function assertBundleIdentity({ manifest, manifestBytes, inventory }: StageMaterializationRequest): void {
  const existing = inventory.manifests.find((item) => item.bundleId === manifest.bundleId);
  if (existing !== undefined && !canonicalBytes(existing).equals(manifestBytes)) {
    throw new Error("operation bundle identity conflict");
  }
  assertWorkspaceId(manifest.workspaceId); // the incumbent derived its paths here, refusing an unsafe workspace
}

/**
 * The run's candidate. With no run bytes, an inventoried run id conflicts before
 * any run read and there is nothing to inspect. With run bytes, the candidate is
 * inspected, and an inventoried run id then requires it to be authoritative.
 */
async function inspectRunCandidate(
  reads: StageMaterializationReads, { manifest, inventory, runBytes }: StageMaterializationRequest,
): Promise<Awaited<ReturnType<StageMaterializationReads["inspectCandidate"]>> | undefined> {
  if (runBytes === undefined) {
    if (inventory.runIds.has(manifest.runId)) throw new Error("operation run identity conflict");
    return undefined;
  }
  const runState = await reads.inspectCandidate(
    { kind: "run", workspaceId: manifest.workspaceId, runId: manifest.runId },
    runBytes, MAX_RUN_BYTES, "operation run identity conflict", 0o600,
  );
  if (inventory.runIds.has(manifest.runId) && runState.authoritative !== true) {
    throw new Error("operation run identity conflict");
  }
  return runState;
}

/** {@link inspectStageMaterialization} over the classifier's own reads and one grouped request: the one body. */
export async function inspectStageMaterializationWith(
  reads: StageMaterializationReads, request: StageMaterializationRequest,
): Promise<StageMaterialization> {
  const { manifest, inventory } = request;
  assertBundleIdentity(request);
  const location = { workspaceId: manifest.workspaceId, bundleId: manifest.bundleId };
  const payloadState = await inspectPayloads(reads, manifest, request.payloads);
  const manifestState = await reads.inspectCandidate(
    { kind: "manifest", ...location }, request.manifestBytes, MAX_MANIFEST_BYTES, "operation bundle manifest identity conflict", 0o600,
  );
  const runState = await inspectRunCandidate(reads, request);
  const complete = inventory.completeBundleIds.has(manifest.bundleId);
  const missingRun = runState?.publicationRequired ?? true;
  return {
    complete, missingManifest: manifestState.publicationRequired,
    missingRun, missingPayloads: payloadState.required,
    physicalActiveByteDelta: payloadState.byteDelta + manifestState.physicalByteDelta,
    settled: !manifestState.publicationRequired && !missingRun && payloadState.required.size === 0,
  };
}

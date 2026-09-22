/**
 * @file src/operation-bundles/capacity.ts
 * @description Complete read-only operation inventory and named launch-cap
 * arithmetic. Unavailable or unknown state poisons health and blocks staging;
 * payload, evidence, orphan, and pending-quarantine bytes are never skipped.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { authoritativeManifests, hasAuthoritativeRun, capacityViolation, uniqueInventoryBytes as uniqueBytes } from "../utils/inventory-arithmetic.js";
import { readCatalogStore } from "./catalog-store.js";
import {
  MAX_ACTIVE_BUNDLE_BYTES, MAX_BUNDLE_PAYLOAD_BYTES, MAX_CATALOG_FILE_BYTES,
  MAX_CATALOG_RECORD_BYTES, MAX_CATALOG_RECORDS_PER_WORKSPACE,
  MAX_MANIFEST_BYTES, MAX_MUTATIONS_PER_BUNDLE, MAX_NEW_BUNDLES_PER_STAGING_CALL,
  MAX_PAYLOAD_BYTES, MAX_PENDING_BUNDLES, MAX_PROJECTION_BYTES,
  MAX_RETAINED_SOURCE_BYTES, MAX_RUN_EVIDENCE_BLOB_BYTES,
  MAX_RUN_EVIDENCE_BYTES, MAX_WORKSPACE_PROJECTION_BYTES,
  MAX_WORKSPACE_RETAINED_SOURCE_BYTES,
} from "./constants.js";
import type { BundleId, OperationRunId } from "./ids.js";
import { verifyInventoryAuthorities } from "./inventory-authority.js";
import { graphNodes, payloadDigestsByBundle } from "./inventory-indexes.js";
import type {
  OperationEpochInventory, OperationEpochInventoryEntry,
} from "./key-epoch.js";
import { readOperationKey } from "./key-epoch.js";
import { readDurableOperationLeafBuffer } from "./durable-leaf.js";
import { operationManifestDigest } from "./manifest-parse.js";
import { manifestPayloadClaims, readOperationManifest } from "./manifest-store.js";
import {
  scanOperationOrphans, type OperationInventoryProblem,
  type OperationLeafObservation, type OperationScanOptions,
} from "./orphan-scan.js";
import { readOperationRun } from "./run-store.js";
import { operationPaths } from "./paths.js";
import type {
  BundleGraphNode, OperationBundleManifest, OperationDigest,
} from "./types.js";

const TERMINAL_STATES = new Set([
  "succeeded", "succeeded-with-warnings", "rejected", "superseded",
  "cancelled", "compensated", "failed", "recovered", "abandoned",
]);

/** Every dimension preflight must project before the first staged write. */
export interface StageCapacityProjection {
  newBundles: number;
  pendingBundles: number;
  mutationCount: number;
  largestPayloadBytes: number;
  bundlePayloadBytes: number;
  manifestBytes: number;
  activeBundleBytes: number;
  largestSourceBytes: number;
  workspaceSourceBytes: number;
  catalogRecordBytes: number;
  catalogRecords: number;
  catalogBytes: number;
  largestProjectionBytes: number;
  workspaceProjectionBytes: number;
  largestEvidenceBytes: number;
  runEvidenceBytes: number;
}

/** Typed refusal naming the cap that invalidated the complete projection. */
export class StageCapacityError extends Error {
  constructor(public readonly dimension: string) {
    super(`operation staging exceeds the ${dimension} cap`);
    this.name = "StageCapacityError";
  }
}

/** Per-workspace founding-store inventory used by staging projections. */
export interface WorkspaceCapacityInventory {
  sourceBytes: number;
  largestSourceBytes: number;
  catalogBytes: number;
  catalogRecords: number;
  projectionBytes: number;
  largestProjectionBytes: number;
  sourceDigests: ReadonlySet<string>;
}

/** Complete healthy or fail-closed project inventory. */
export interface OperationInventory {
  epoch: OperationEpochInventory;
  quarantine: OperationEpochInventoryEntry;
  activeBytes: number;
  pendingBundles: number;
  problems: readonly OperationInventoryProblem[];
  manifests: readonly OperationBundleManifest[];
  graphNodes: ReadonlyMap<BundleId, BundleGraphNode>;
  workspaces: ReadonlyMap<string, WorkspaceCapacityInventory>;
  bundleIds: ReadonlySet<BundleId>;
  runIds: ReadonlySet<OperationRunId>;
  completeBundleIds: ReadonlySet<BundleId>;
  payloadDigestsByBundle: ReadonlyMap<string, ReadonlySet<string>>;
}

interface ManifestState {
  manifest: OperationBundleManifest;
  complete: boolean;
  pending: boolean;
}

const CAP_ENTRIES: ReadonlyArray<[
  keyof StageCapacityProjection, number, string,
]> = [
  ["newBundles", MAX_NEW_BUNDLES_PER_STAGING_CALL, "new-bundles"],
  ["pendingBundles", MAX_PENDING_BUNDLES, "pending-bundles"],
  ["mutationCount", MAX_MUTATIONS_PER_BUNDLE, "mutations"],
  ["largestPayloadBytes", MAX_PAYLOAD_BYTES, "payload"],
  ["bundlePayloadBytes", MAX_BUNDLE_PAYLOAD_BYTES, "bundle-payloads"],
  ["manifestBytes", MAX_MANIFEST_BYTES, "manifest"],
  ["activeBundleBytes", MAX_ACTIVE_BUNDLE_BYTES, "active-bytes"],
  ["largestSourceBytes", MAX_RETAINED_SOURCE_BYTES, "source"],
  ["workspaceSourceBytes", MAX_WORKSPACE_RETAINED_SOURCE_BYTES, "workspace-sources"],
  ["catalogRecordBytes", MAX_CATALOG_RECORD_BYTES, "catalog-record"],
  ["catalogRecords", MAX_CATALOG_RECORDS_PER_WORKSPACE, "catalog-records"],
  ["catalogBytes", MAX_CATALOG_FILE_BYTES, "catalog"],
  ["largestProjectionBytes", MAX_PROJECTION_BYTES, "projection"],
  ["workspaceProjectionBytes", MAX_WORKSPACE_PROJECTION_BYTES, "workspace-projections"],
  ["largestEvidenceBytes", MAX_RUN_EVIDENCE_BLOB_BYTES, "evidence"],
  ["runEvidenceBytes", MAX_RUN_EVIDENCE_BYTES, "run-evidence"],
];

/** Require nonnegative exact arithmetic and enforce every inclusive cap. */
export function assertStageCapacity(projection: StageCapacityProjection): void {
  const dimension = capacityViolation(projection, CAP_ENTRIES);
  if (dimension !== undefined) throw new StageCapacityError(dimension);
}

/** Count logical objects, folding `.tmp` and `.writing` into their destination. */
function logicalCount(leaves: readonly OperationLeafObservation[]): number {
  return new Set(leaves.map((leaf) => leaf.logicalRelativePath)).size;
}

/** Return an exact entry whose health follows the complete scan. */
function entry(
  leaves: readonly OperationLeafObservation[],
  unavailable: boolean,
): OperationEpochInventoryEntry {
  return {
    count: logicalCount(leaves), bytes: uniqueBytes(leaves),
    health: unavailable ? "unavailable" : "ok",
  };
}

/** Read every authoritative manifest and preserve invalid/unavailable state. */
async function readManifests(
  root: string,
  leaves: readonly OperationLeafObservation[],
  problems: OperationInventoryProblem[],
): Promise<Map<string, OperationBundleManifest>> {
  const result = new Map<string, OperationBundleManifest>();
  const workspaceByBundle = new Map<BundleId, string>();
  for (const leaf of authoritativeManifests(leaves)) {
    if (leaf.workspaceId === undefined || leaf.bundleId === undefined) continue;
    const read = await readOperationManifest(root, leaf.workspaceId, leaf.bundleId as BundleId);
    if (read.status === "ok") {
      const priorWorkspace = workspaceByBundle.get(read.manifest.bundleId);
      if (priorWorkspace !== undefined && priorWorkspace !== read.manifest.workspaceId) {
        problems.push({ dimension: "bundle-identity", detail: "bundle identity exists in multiple workspaces" });
      }
      workspaceByBundle.set(read.manifest.bundleId, read.manifest.workspaceId);
      result.set(`${leaf.workspaceId}\0${leaf.bundleId}`, read.manifest);
    } else {
      problems.push({
        dimension: "manifest-state", detail: `operation manifest is ${read.status}`,
        path: path.join(".llmwiki", "workspaces", leaf.relativePath),
      });
    }
  }
  return result;
}

/** Verify every authoritative manifest payload through its confined bytes. */
async function verifyManifestPayloads(
  root: string,
  manifest: OperationBundleManifest,
  leaves: readonly OperationLeafObservation[],
  problems: OperationInventoryProblem[],
): Promise<boolean> {
  for (const [digest, claims] of manifestPayloadClaims(manifest)) {
    const present = leaves.some((leaf) => leaf.kind === "payload" &&
      leaf.workspaceId === manifest.workspaceId && leaf.bundleId === manifest.bundleId &&
      leaf.protocolAlias === undefined && path.basename(leaf.logicalRelativePath) === digest);
    if (!present) return false;
    const paths = operationPaths(root, manifest.workspaceId);
    const read = await readDurableOperationLeafBuffer(
      root, paths.payloadFile(manifest.bundleId, digest), paths.payloadsRoot(manifest.bundleId),
      MAX_PAYLOAD_BYTES,
    );
    const valid = read.kind === "ok" &&
      createHash("sha256").update(read.body).digest("hex") === digest &&
      claims.every((count) => count === read.body.byteLength);
    if (!valid) {
      problems.push({ dimension: "payload-state", detail: "manifest payload is unavailable or invalid" });
      return false;
    }
  }
  return true;
}

interface InventorySummary {
  epoch: OperationEpochInventory;
  quarantine: OperationEpochInventoryEntry;
  activeBytes: number;
}

/** Build exact epoch and quarantine totals from the already-classified scan. */
function summarizeInventory(
  scan: Awaited<ReturnType<typeof scanOperationOrphans>>,
  classified: Awaited<ReturnType<typeof classifyBundles>>,
  manifests: Map<string, OperationBundleManifest>,
  problems: OperationInventoryProblem[],
): InventorySummary {
  const unavailable = problems.length > 0;
  const byKind = (kind: OperationLeafObservation["kind"]) =>
    scan.leaves.filter((leaf) => leaf.kind === kind);
  const quarantineLeaves = byKind("quarantine");
  const payloadLeaves = byKind("payload"), evidenceLeaves = byKind("evidence");
  const activeLeaves = [...payloadLeaves, ...evidenceLeaves,
    ...classified.orphanLeaves, ...quarantineLeaves];
  const orphanBundles = new Set(classified.orphanLeaves.filter((leaf) =>
    leaf.bundleId !== undefined).map((leaf) => `${leaf.workspaceId}\0${leaf.bundleId}`));
  const manifestRuns = new Set([...manifests.values()]
    .map((manifest) => `${manifest.workspaceId}\0${manifest.runId}`));
  const orphanRuns = new Set(classified.orphanLeaves.filter((leaf) =>
    leaf.runId !== undefined).map((leaf) => `${leaf.workspaceId}\0${leaf.runId}`)
    .filter((key) => !manifestRuns.has(key)));
  const epoch: OperationEpochInventory = {
    bundles: entry(byKind("manifest"), unavailable), runs: entry(byKind("run"), unavailable),
    payloads: entry(payloadLeaves, unavailable), evidence: entry(evidenceLeaves, unavailable),
    cancelRequests: entry(byKind("cancel"), unavailable),
    orphans: { count: orphanBundles.size + orphanRuns.size,
      bytes: uniqueBytes(classified.orphanLeaves), health: unavailable ? "unavailable" : "ok" },
  };
  const quarantineUnavailable = problems.some((item) =>
    item.path?.startsWith(path.join(".llmwiki", "workspaces", ".quarantine")) === true);
  return { epoch, quarantine: entry(quarantineLeaves, quarantineUnavailable),
    activeBytes: uniqueBytes(activeLeaves) };
}

/** Verify payload coverage and an authenticated run for one parsed manifest. */
async function manifestState(
  root: string,
  manifest: OperationBundleManifest,
  leaves: readonly OperationLeafObservation[],
  problems: OperationInventoryProblem[],
): Promise<ManifestState> {
  const payloadsComplete = await verifyManifestPayloads(root, manifest, leaves, problems);
  const runLeaf = hasAuthoritativeRun(leaves, manifest);
  if (!payloadsComplete || !runLeaf) {
    return { manifest, complete: false, pending: false };
  }
  const key = await readOperationKey(root);
  if (key.status !== "ok") {
    problems.push({ dimension: "run-state", detail: `operation key is ${key.status}` });
    return { manifest, complete: false, pending: false };
  }
  const run = await readOperationRun(root, {
    bundleId: manifest.bundleId, runId: manifest.runId,
    workspaceId: manifest.workspaceId,
    manifestDigest: operationManifestDigest(manifest) as OperationDigest,
    keyEpochId: key.keyEpochId,
  });
  if (run.status !== "ok") {
    problems.push({ dimension: "run-state", detail: `operation run is ${run.status}` });
    return { manifest, complete: false, pending: false };
  }
  return {
    manifest, complete: true, pending: !TERMINAL_STATES.has(run.run.state),
  };
}

/** Inventory founding stores without trusting invalid catalogs as empty. */
async function workspaceCapacity(
  root: string,
  workspaceId: string,
  leaves: readonly OperationLeafObservation[],
  problems: OperationInventoryProblem[],
): Promise<WorkspaceCapacityInventory> {
  const owned = leaves.filter((leaf) => leaf.workspaceId === workspaceId);
  const sources = owned.filter((leaf) => leaf.kind === "source");
  const projections = owned.filter((leaf) => leaf.kind === "projection");
  const catalogLeaves = owned.filter((leaf) => leaf.kind === "catalog");
  const catalog = await readCatalogStore(root, workspaceId);
  if (catalog.status === "invalid" || catalog.status === "unavailable") {
    problems.push({ dimension: "catalog-state", detail: catalog.detail });
  }
  const result = {
    sourceBytes: uniqueBytes(sources),
    largestSourceBytes: Math.max(0, ...sources.map((leaf) => leaf.bytes)),
    catalogBytes: uniqueBytes(catalogLeaves),
    catalogRecords: catalog.status === "ok" ? catalog.records.length : 0,
    projectionBytes: uniqueBytes(projections),
    largestProjectionBytes: Math.max(0, ...projections.map((leaf) => leaf.bytes)),
    sourceDigests: new Set(sources.filter((leaf) => leaf.protocolAlias === undefined)
      .map((leaf) => path.basename(leaf.logicalRelativePath))),
  };
  if (result.sourceBytes > MAX_WORKSPACE_RETAINED_SOURCE_BYTES) {
    problems.push({ dimension: "workspace-sources", detail: "retained sources exceed their workspace cap" });
  }
  if (result.projectionBytes > MAX_WORKSPACE_PROJECTION_BYTES) {
    problems.push({ dimension: "workspace-projections", detail: "projections exceed their workspace cap" });
  }
  return result;
}

/** Group payloads and evidence by their exact protocol owner. */
function aggregateBlobGroups(
  leaves: readonly OperationLeafObservation[],
): Map<string, OperationLeafObservation[]> {
  const groups = new Map<string, OperationLeafObservation[]>();
  for (const leaf of leaves) {
    const key = aggregateBlobOwner(leaf);
    if (key === null) continue;
    groups.set(key, [...(groups.get(key) ?? []), leaf]);
  }
  return groups;
}

/** Return the stable aggregate owner key for one counted blob. */
function aggregateBlobOwner(leaf: OperationLeafObservation): string | null {
  if (leaf.kind === "payload") {
    return `payload\0${leaf.workspaceId ?? ""}\0${leaf.bundleId ?? ""}`;
  }
  if (leaf.kind === "evidence") {
    return `evidence\0${leaf.workspaceId ?? ""}\0${leaf.runId ?? ""}`;
  }
  return null;
}

/** Mark aggregate bundle-payload and per-run evidence overages unavailable. */
function assertAggregateBlobCaps(
  leaves: readonly OperationLeafObservation[],
  problems: OperationInventoryProblem[],
): void {
  const groups = aggregateBlobGroups(leaves);
  for (const [key, values] of groups) {
    const evidence = key.startsWith("evidence\0"), bytes = uniqueBytes(values);
    const limit = evidence ? MAX_RUN_EVIDENCE_BYTES : MAX_BUNDLE_PAYLOAD_BYTES;
    if (bytes > limit) {
      problems.push({
        dimension: evidence ? "run-evidence" : "bundle-payloads",
        detail: "operation blob aggregate exceeds its owner cap",
      });
    }
  }
}

/** Compute complete orphan and pending classifications from verified records. */
async function classifyBundles(
  root: string,
  scan: Awaited<ReturnType<typeof scanOperationOrphans>>,
  manifests: Map<string, OperationBundleManifest>,
  problems: OperationInventoryProblem[],
): Promise<{ states: ManifestState[]; orphanLeaves: OperationLeafObservation[]; pending: number }> {
  const states: ManifestState[] = [];
  for (const manifest of manifests.values()) {
    states.push(await manifestState(root, manifest, scan.leaves, problems));
  }
  const complete = new Set(states.filter((item) => item.complete)
    .map((item) => `${item.manifest.workspaceId}\0${item.manifest.bundleId}`));
  const orphanBundles = new Set(scan.bundleDirectories.map((bundle) => `${bundle.workspaceId}\0${bundle.bundleId}`)
    .filter((key) => !complete.has(key)));
  const orphanRuns = new Set(scan.leaves.filter((leaf) => leaf.kind === "run")
    .map((leaf) => `${leaf.workspaceId ?? ""}\0${leaf.runId ?? ""}`)
    .filter((key) => !states.some((item) => item.complete &&
      key === `${item.manifest.workspaceId}\0${item.manifest.runId}`)));
  const orphanLeaves = scan.leaves.filter((leaf) =>
    (leaf.bundleId !== undefined && orphanBundles.has(`${leaf.workspaceId}\0${leaf.bundleId}`)) ||
    (leaf.runId !== undefined && orphanRuns.has(`${leaf.workspaceId}\0${leaf.runId}`)));
  const pending = states.filter((item) => item.pending).length;
  return { states, orphanLeaves, pending };
}

/** Inventory the complete project operation epoch without side effects. */
export async function scanOperationInventory(
  root: string,
  options: OperationScanOptions = {},
): Promise<OperationInventory> {
  const scan = await scanOperationOrphans(root, options);
  const problems = [...scan.problems];
  await verifyInventoryAuthorities(root, scan.leaves, problems);
  const manifests = await readManifests(root, scan.leaves, problems);
  const classified = await classifyBundles(root, scan, manifests, problems);
  const workspaceIds = new Set([...scan.workspaces, ...[...manifests.values()].map((item) => item.workspaceId)]);
  const workspaces = new Map<string, WorkspaceCapacityInventory>();
  for (const workspaceId of [...workspaceIds].sort()) {
    workspaces.set(workspaceId, await workspaceCapacity(root, workspaceId, scan.leaves, problems));
  }
  assertAggregateBlobCaps(scan.leaves, problems);
  const summary = summarizeInventory(scan, classified, manifests, problems);
  return {
    ...summary, pendingBundles: classified.pending,
    problems, manifests: [...manifests.values()],
    graphNodes: graphNodes([...manifests.values()]), workspaces,
    bundleIds: new Set(scan.bundleDirectories.map((item) => item.bundleId as BundleId)),
    runIds: new Set(scan.leaves.filter((leaf) => leaf.kind === "run" && leaf.runId !== undefined &&
      leaf.protocolAlias === undefined)
      .map((leaf) => leaf.runId as OperationRunId)),
    completeBundleIds: new Set(classified.states.filter((item) => item.complete)
      .map((item) => item.manifest.bundleId)),
    payloadDigestsByBundle: payloadDigestsByBundle(scan.leaves),
  };
}

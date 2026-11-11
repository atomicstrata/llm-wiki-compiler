/**
 * @file src/operation-bundles/capacity.ts
 * @description Complete read-only operation inventory and named launch-cap
 * arithmetic. Unavailable or unknown state poisons health and blocks staging;
 * payload, evidence, orphan, and pending-quarantine bytes are never skipped.
 * The pure cap arithmetic lives in `capacity-caps.ts` and is re-exported here.
 *
 * ONE BODY, OVER THE SCAN'S OWN READS. `scanOperationInventoryFrom` is the
 * single body and takes `OperationInventoryReads` (the shape of
 * `PreparationInventoryReads`) and no project root. It owns the step order,
 * every problem it adds, the payload digest and byte-claim check, the fresh key
 * and run read per manifest, orphan and pending classification, health and
 * totals. `scanOperationInventory` keeps its signature and delegates over the
 * local-disk reads, built on each call, each calling the incumbent root-taking
 * function when asked. Those reads are NOT made storage-neutral by being named:
 * the store walk, manifest read, authority verification (`inventory-authority.ts`)
 * and catalog read still take a project root on disk. Nothing selects a backend.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import type { CappedLeafReadBuffer } from "../utils/confined-read.js";
import { authoritativeManifests, hasAuthoritativeRun, uniqueInventoryBytes as uniqueBytes } from "../utils/inventory-arithmetic.js";
import { assertAggregateBlobCaps } from "./capacity-caps.js";
import { readCatalogStore, type CatalogStoreRead } from "./catalog-store.js";
import {
  MAX_PAYLOAD_BYTES, MAX_WORKSPACE_PROJECTION_BYTES,
  MAX_WORKSPACE_RETAINED_SOURCE_BYTES,
} from "./constants.js";
import type { BundleId, OperationRunId } from "./ids.js";
import { diskInventoryAuthorityReads, verifyInventoryAuthoritiesFrom } from "./inventory-authority.js";
import { graphNodes, payloadDigestsByBundle } from "./inventory-indexes.js";
import type {
  OperationEpochInventory, OperationEpochInventoryEntry,
} from "./key-epoch.js";
import { readDurableOperationLeafBuffer } from "./durable-leaf.js";
import { operationManifestDigest } from "./manifest-parse.js";
import { manifestPayloadClaims, type OperationManifestRead } from "./manifest-store.js";
import {
  scanOperationOrphans, type OperationInventoryProblem,
  type OperationLeafObservation, type OperationOrphanScan, type OperationScanOptions,
} from "./orphan-scan.js";
import type { OperationRunRead } from "./run-store.js";
import type { OperationRunBinding } from "./run-types.js";
import { operationPaths } from "./paths.js";
import { operationPassReads, type OperationPassReads } from "./pass-reads.js";
import type {
  BundleGraphNode, OperationBundleManifest, OperationDigest,
} from "./types.js";

export {
  assertStageCapacity, StageCapacityError, type StageCapacityProjection,
} from "./capacity-caps.js";

const TERMINAL_STATES = new Set([
  "succeeded", "succeeded-with-warnings", "rejected", "superseded",
  "cancelled", "compensated", "failed", "recovered", "abandoned",
]);

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

/**
 * What the inventory scan asks of the operation store. Owned by the scan; no
 * read takes a project root. Each answers for itself exactly as the incumbent
 * root-taking function does, faults included; a rejection rejects the scan.
 */
export interface OperationInventoryReads {
  /** The complete store walk: leaves, workspaces, bundle directories and problems. */
  scanStore(options: OperationScanOptions): Promise<OperationOrphanScan>;
  /** Re-read and authenticate founding-store leaves; the problems found, in order. */
  verifyAuthorities(leaves: readonly OperationLeafObservation[]): Promise<readonly OperationInventoryProblem[]>;
  /** One manifest by workspace and bundle. */
  readManifest(workspaceId: string, bundleId: BundleId): Promise<OperationManifestRead>;
  /** One bundle payload leaf's bytes within `maxBytes`; a path it cannot derive rejects. */
  readPayloadLeaf(workspaceId: string, bundleId: BundleId, digest: string, maxBytes: number): Promise<CappedLeafReadBuffer>;
  /** Whether the operation key can be read, and its epoch. NEVER the key bytes. */
  readKeyEpoch(): Promise<
    | { status: "ok"; keyEpochId: OperationRunBinding["keyEpochId"] }
    | { status: "absent" }
    | { status: "unavailable" }
  >;
  /** One run leaf by its binding, authenticated by whatever answers. */
  readRun(binding: OperationRunBinding): Promise<OperationRunRead>;
  /** One workspace's catalog. */
  readCatalog(workspaceId: string): Promise<CatalogStoreRead>;
}

/** The incumbent payload leaf read for one root: path derivation, then the confined durable read. */
function readDiskPayloadLeaf(root: string, workspaceId: string, bundleId: BundleId, digest: string, maxBytes: number) {
  const paths = operationPaths(root, workspaceId);
  return readDurableOperationLeafBuffer(root, paths.payloadFile(bundleId, digest), paths.payloadsRoot(bundleId), maxBytes);
}

/**
 * The local-disk reads for one project root, built per call: each closure calls
 * the imported root-taking function when it is asked, never earlier. In no
 * package index.
 */
export function diskOperationInventoryReads(root: string, pass: OperationPassReads = operationPassReads(root)): OperationInventoryReads {
  return {
    scanStore: (options) => scanOperationOrphans(root, options),
    verifyAuthorities: async (leaves) => {
      const problems: OperationInventoryProblem[] = [];
      await verifyInventoryAuthoritiesFrom(diskInventoryAuthorityReads(root, pass.readKey), leaves, problems);
      return problems;
    },
    readManifest: pass.readManifest,
    readPayloadLeaf: (workspaceId, bundleId, digest, maxBytes) => readDiskPayloadLeaf(root, workspaceId, bundleId, digest, maxBytes),
    readKeyEpoch: pass.readKeyEpoch,
    readRun: pass.readRun,
    readCatalog: (workspaceId) => readCatalogStore(root, workspaceId),
  };
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
  reads: OperationInventoryReads,
  leaves: readonly OperationLeafObservation[],
  problems: OperationInventoryProblem[],
): Promise<Map<string, OperationBundleManifest>> {
  const result = new Map<string, OperationBundleManifest>();
  const workspaceByBundle = new Map<BundleId, string>();
  for (const leaf of authoritativeManifests(leaves)) {
    if (leaf.workspaceId === undefined || leaf.bundleId === undefined) continue;
    const read = await reads.readManifest(leaf.workspaceId, leaf.bundleId as BundleId);
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
  reads: OperationInventoryReads,
  manifest: OperationBundleManifest,
  leaves: readonly OperationLeafObservation[],
  problems: OperationInventoryProblem[],
): Promise<boolean> {
  for (const [digest, claims] of manifestPayloadClaims(manifest)) {
    const present = leaves.some((leaf) => leaf.kind === "payload" &&
      leaf.workspaceId === manifest.workspaceId && leaf.bundleId === manifest.bundleId &&
      leaf.protocolAlias === undefined && path.basename(leaf.logicalRelativePath) === digest);
    if (!present) return false;
    const read = await reads.readPayloadLeaf(manifest.workspaceId, manifest.bundleId, digest, MAX_PAYLOAD_BYTES);
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
  scan: OperationOrphanScan,
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
  reads: OperationInventoryReads,
  manifest: OperationBundleManifest,
  leaves: readonly OperationLeafObservation[],
  problems: OperationInventoryProblem[],
): Promise<ManifestState> {
  const payloadsComplete = await verifyManifestPayloads(reads, manifest, leaves, problems);
  const runLeaf = hasAuthoritativeRun(leaves, manifest);
  if (!payloadsComplete || !runLeaf) {
    return { manifest, complete: false, pending: false };
  }
  const key = await reads.readKeyEpoch();
  if (key.status !== "ok") {
    problems.push({ dimension: "run-state", detail: `operation key is ${key.status}` });
    return { manifest, complete: false, pending: false };
  }
  const run = await reads.readRun({
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
  reads: OperationInventoryReads,
  workspaceId: string,
  leaves: readonly OperationLeafObservation[],
  problems: OperationInventoryProblem[],
): Promise<WorkspaceCapacityInventory> {
  const owned = leaves.filter((leaf) => leaf.workspaceId === workspaceId);
  const sources = owned.filter((leaf) => leaf.kind === "source");
  const projections = owned.filter((leaf) => leaf.kind === "projection");
  const catalogLeaves = owned.filter((leaf) => leaf.kind === "catalog");
  const catalog = await reads.readCatalog(workspaceId);
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

/** Compute complete orphan and pending classifications from verified records. */
async function classifyBundles(
  reads: OperationInventoryReads,
  scan: OperationOrphanScan,
  manifests: Map<string, OperationBundleManifest>,
  problems: OperationInventoryProblem[],
): Promise<{ states: ManifestState[]; orphanLeaves: OperationLeafObservation[]; pending: number }> {
  const states: ManifestState[] = [];
  for (const manifest of manifests.values()) {
    states.push(await manifestState(reads, manifest, scan.leaves, problems));
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
  pass: OperationPassReads = operationPassReads(root),
): Promise<OperationInventory> {
  return scanOperationInventoryFrom(diskOperationInventoryReads(root, pass), options);
}

/** {@link scanOperationInventory} over the scan's own reads: the one body. */
export async function scanOperationInventoryFrom(
  reads: OperationInventoryReads,
  options: OperationScanOptions = {},
): Promise<OperationInventory> {
  const scan = await reads.scanStore(options);
  const problems = [...scan.problems];
  problems.push(...await reads.verifyAuthorities(scan.leaves));
  const manifests = await readManifests(reads, scan.leaves, problems);
  const classified = await classifyBundles(reads, scan, manifests, problems);
  const workspaceIds = new Set([...scan.workspaces, ...[...manifests.values()].map((item) => item.workspaceId)]);
  const workspaces = new Map<string, WorkspaceCapacityInventory>();
  for (const workspaceId of [...workspaceIds].sort()) {
    workspaces.set(workspaceId, await workspaceCapacity(reads, workspaceId, scan.leaves, problems));
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

/**
 * @file test/operation-bundles/capacity.test.ts
 * @description Task 6 inventory and cap arithmetic tests. They prove orphan and
 * quarantine bytes consume capacity and every launch dimension has a name.
 */

import path from "node:path";
import { link, mkdir, open, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  MAX_ACTIVE_BUNDLE_BYTES, MAX_BUNDLE_PAYLOAD_BYTES, MAX_CATALOG_FILE_BYTES,
  MAX_CATALOG_RECORD_BYTES, MAX_CATALOG_RECORDS_PER_WORKSPACE,
  MAX_MANIFEST_BYTES, MAX_MUTATIONS_PER_BUNDLE, MAX_NEW_BUNDLES_PER_STAGING_CALL,
  MAX_PAYLOAD_BYTES, MAX_PENDING_BUNDLES, MAX_PROJECTION_BYTES,
  MAX_RETAINED_SOURCE_BYTES, MAX_RUN_EVIDENCE_BLOB_BYTES,
  MAX_RUN_EVIDENCE_BYTES, MAX_WORKSPACE_PROJECTION_BYTES,
  MAX_WORKSPACE_RETAINED_SOURCE_BYTES,
} from "../../src/operation-bundles/constants.js";
import {
  assertStageCapacity,
  scanOperationInventory,
  StageCapacityError,
  type StageCapacityProjection,
} from "../../src/operation-bundles/capacity.js";
import { mintBundleId } from "../../src/operation-bundles/ids.js";
import { operationPaths } from "../../src/operation-bundles/paths.js";
import { writePayloadCreateOnly } from "../../src/operation-bundles/payload-store.js";
import {
  projectionOutputPath, writeProjectionLocked,
} from "../../src/operation-bundles/projection-store.js";
import { writeRetainedSourceCreateOnly } from "../../src/operation-bundles/source-store.js";
import { createHash } from "node:crypto";
import { useTempRoot } from "../fixtures/temp-root.js";
import {
  proveAggregatePayloadCap, proveCatalogByteCap, proveCatalogRecordCountCap,
  proveIndividualPayloadCap, proveManifestCap, proveWorkspaceSourceCap,
} from "./stage-capacity-fixtures.js";

const root = useTempRoot();

/** Return a zero-valued complete cap projection. */
function emptyProjection(): StageCapacityProjection {
  return {
    newBundles: 0, pendingBundles: 0, mutationCount: 0, largestPayloadBytes: 0,
    bundlePayloadBytes: 0, manifestBytes: 0, activeBundleBytes: 0,
    largestSourceBytes: 0, workspaceSourceBytes: 0, catalogRecordBytes: 0,
    catalogRecords: 0, catalogBytes: 0, largestProjectionBytes: 0,
    workspaceProjectionBytes: 0, largestEvidenceBytes: 0, runEvidenceBytes: 0,
  };
}

const OVER_LIMITS: Record<keyof StageCapacityProjection, { limit: number; dimension: string }> = {
  newBundles: { limit: MAX_NEW_BUNDLES_PER_STAGING_CALL, dimension: "new-bundles" },
  pendingBundles: { limit: MAX_PENDING_BUNDLES, dimension: "pending-bundles" },
  mutationCount: { limit: MAX_MUTATIONS_PER_BUNDLE, dimension: "mutations" },
  largestPayloadBytes: { limit: MAX_PAYLOAD_BYTES, dimension: "payload" },
  bundlePayloadBytes: { limit: MAX_BUNDLE_PAYLOAD_BYTES, dimension: "bundle-payloads" },
  manifestBytes: { limit: MAX_MANIFEST_BYTES, dimension: "manifest" },
  activeBundleBytes: { limit: MAX_ACTIVE_BUNDLE_BYTES, dimension: "active-bytes" },
  largestSourceBytes: { limit: MAX_RETAINED_SOURCE_BYTES, dimension: "source" },
  workspaceSourceBytes: { limit: MAX_WORKSPACE_RETAINED_SOURCE_BYTES, dimension: "workspace-sources" },
  catalogRecordBytes: { limit: MAX_CATALOG_RECORD_BYTES, dimension: "catalog-record" },
  catalogRecords: { limit: MAX_CATALOG_RECORDS_PER_WORKSPACE, dimension: "catalog-records" },
  catalogBytes: { limit: MAX_CATALOG_FILE_BYTES, dimension: "catalog" },
  largestProjectionBytes: { limit: MAX_PROJECTION_BYTES, dimension: "projection" },
  workspaceProjectionBytes: { limit: MAX_WORKSPACE_PROJECTION_BYTES, dimension: "workspace-projections" },
  largestEvidenceBytes: { limit: MAX_RUN_EVIDENCE_BLOB_BYTES, dimension: "evidence" },
  runEvidenceBytes: { limit: MAX_RUN_EVIDENCE_BYTES, dimension: "run-evidence" },
};

const OVER_LIMIT_CASES = Object.entries(OVER_LIMITS).map(([field, value]) =>
  [field as keyof StageCapacityProjection, value.limit, value.dimension] as const);

/** Derive one content-addressed payload location for inventory fixtures. */
function payloadLocation(bytes: Buffer, bundleId = mintBundleId()) {
  const paths = operationPaths(root.dir, "research");
  const digest = createHash("sha256").update(bytes).digest("hex");
  return { bundleId, digest, paths, file: paths.payloadFile(bundleId, digest) };
}

/** Require one logical payload to remain visible as one physical orphan. */
function expectOrphanPayload(
  inventory: Awaited<ReturnType<typeof scanOperationInventory>>,
  bytes: number,
): void {
  expect(inventory.epoch.payloads).toEqual({ count: 1, bytes, health: "ok" });
  expect(inventory.epoch.orphans).toEqual({ count: 1, bytes, health: "ok" });
}

describe("operation capacity", () => {
  it("returns the exact healthy empty epoch inventory without writing", async () => {
    const inventory = await scanOperationInventory(root.dir);

    expect(Object.keys(inventory.epoch).sort()).toEqual([
      "bundles", "cancelRequests", "evidence", "orphans", "payloads", "runs",
    ]);
    for (const value of Object.values(inventory.epoch)) {
      expect(value).toEqual({ count: 0, bytes: 0, health: "ok" });
    }
    expect(inventory).toMatchObject({ activeBytes: 0, pendingBundles: 0, problems: [] });
  });

  it("counts payload-only bundles as inert active-capacity orphans", async () => {
    const bytes = Buffer.from("orphan payload"), location = payloadLocation(bytes);
    await writePayloadCreateOnly(root.dir, { workspaceId: "research", ...location }, bytes);

    const inventory = await scanOperationInventory(root.dir);

    expectOrphanPayload(inventory, bytes.length);
    expect(inventory).toMatchObject({ activeBytes: bytes.length, pendingBundles: 0, problems: [] });
  });

  it("classifies reserved quarantine separately while rejecting other dot entries", async () => {
    const paths = operationPaths(root.dir, "research");
    const bytes = Buffer.from("pending quarantine");
    await mkdir(path.join(paths.quarantineRoot, "reset-one", "bytes"), { recursive: true });
    await writeFile(path.join(paths.quarantineRoot, "reset-one", "bytes", "part"), bytes);
    await mkdir(path.join(paths.workspacesRoot, ".hidden"), { recursive: true });

    const inventory = await scanOperationInventory(root.dir);

    expect(inventory.quarantine).toEqual({ count: 1, bytes: bytes.length, health: "ok" });
    expect(inventory.activeBytes).toBe(bytes.length);
    expect(inventory.problems.map((item) => item.dimension)).toContain("workspace-entry");
  });

  it("rejects nested quarantine dot entries without losing visible bytes", async () => {
    const paths = operationPaths(root.dir, "research");
    await mkdir(path.join(paths.quarantineRoot, "reset-one"), { recursive: true });
    await writeFile(path.join(paths.quarantineRoot, "reset-one", ".hidden"), "held");

    const inventory = await scanOperationInventory(root.dir);

    expect(inventory.problems.map((item) => item.dimension)).toContain("operation-entry");
    expect(inventory.quarantine.bytes).toBe(4);
  });

  it("folds durable aliases by logical object and physical inode", async () => {
    const bytes = Buffer.from("ready payload"), location = payloadLocation(bytes);
    await mkdir(location.paths.payloadsRoot(location.bundleId), { recursive: true });
    await writeFile(location.file, bytes);
    await link(location.file, `${location.file}.tmp`);

    const inventory = await scanOperationInventory(root.dir);

    expectOrphanPayload(inventory, bytes.length);
  });

  it("marks an oversize orphan payload unavailable without reading its body", async () => {
    const bundleId = mintBundleId(), digest = "b".repeat(64);
    const paths = operationPaths(root.dir, "research"), file = paths.payloadFile(bundleId, digest);
    await mkdir(paths.payloadsRoot(bundleId), { recursive: true });
    const handle = await open(file, "w");
    await handle.truncate(MAX_PAYLOAD_BYTES + 1);
    await handle.close();

    const inventory = await scanOperationInventory(root.dir);

    expect(inventory.problems.map((item) => item.dimension)).toContain("payload-bytes");
    expect(inventory.epoch.payloads.health).toBe("unavailable");
  });

  it("blocks staging inventory when retained-source bytes no longer match their filename", async () => {
    const bytes = Buffer.from("source one"), digest = createHash("sha256").update(bytes).digest("hex");
    const location = { workspaceId: "research", digest };
    await writeRetainedSourceCreateOnly(root.dir, location, bytes);
    await writeFile(operationPaths(root.dir, location.workspaceId).sourceFile(digest), "source two");

    const inventory = await scanOperationInventory(root.dir);

    expect(inventory.problems.map((item) => item.dimension)).toContain("source-state");
  });

  it("blocks staging inventory when projection bytes no longer match their marker", async () => {
    const bytes = Buffer.from("projection one");
    const target = {
      workspaceId: "research", recipeId: "daily-brief",
      recipeDigest: `sha256:${"a".repeat(64)}` as const,
      output: "brief.md",
      outputDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const,
      criticality: "required" as const,
    };
    await writeProjectionLocked(root.dir, target, bytes);
    await writeFile(projectionOutputPath(root.dir, target), "projection two");

    const inventory = await scanOperationInventory(root.dir);

    expect(inventory.problems.map((item) => item.dimension)).toContain("projection-state");
  });

  it("fails a bounded directory inventory instead of skipping excess entries", async () => {
    const paths = operationPaths(root.dir, "research");
    await mkdir(path.join(paths.workspacesRoot, "one"), { recursive: true });
    await mkdir(path.join(paths.workspacesRoot, "two"), { recursive: true });

    const inventory = await scanOperationInventory(root.dir, { maxDirectoryEntriesForTest: 1 });

    expect(inventory.problems.map((item) => item.dimension)).toContain("directory-entries");
    expect(Object.values(inventory.epoch).some((item) => item.health === "unavailable")).toBe(true);
  });

  it("rejects an unknown workspace child directory even when it is empty", async () => {
    const paths = operationPaths(root.dir, "research");
    await mkdir(path.join(paths.workspaceRoot, "unknown-store"), { recursive: true });

    const inventory = await scanOperationInventory(root.dir);

    expect(inventory.problems.map((item) => item.dimension)).toContain("operation-entry");
  });

  it.each(OVER_LIMIT_CASES)("names the %s cap and never clamps", (field, limit, dimension) => {
    const exact = { ...emptyProjection(), [field]: limit };
    expect(() => assertStageCapacity(exact)).not.toThrow();

    const over = { ...emptyProjection(), [field]: limit + 1 };
    let caught: unknown;
    try { assertStageCapacity(over); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(StageCapacityError);
    expect(caught).toMatchObject({ dimension });
    expect((caught as Error).message).toContain(dimension);
  });

  it("enforces individual payload bytes through staging without partial writes", async () => {
    await proveIndividualPayloadCap(root.dir);
  });

  it("enforces aggregate bundle payload bytes through staging without partial writes", async () => {
    await proveAggregatePayloadCap(root.dir);
  });

  it("enforces manifest bytes through staging without partial writes", async () => {
    await proveManifestCap(root.dir);
  });

  it("enforces workspace retained-source bytes through staging without partial writes", async () => {
    await proveWorkspaceSourceCap(root.dir);
  }, 60_000);

  it("enforces catalog record count through staging without partial writes", async () => {
    await proveCatalogRecordCountCap(root.dir);
  }, 60_000);

  it("enforces catalog aggregate bytes through staging without partial writes", async () => {
    await proveCatalogByteCap(root.dir);
  }, 60_000);
});

/**
 * @file test/operation-bundles/manifest-store.test.ts
 * @description Contract tests for canonical, create-only operation manifests.
 * Reads preserve absent, invalid, and unavailable as distinct classifications.
 */

import path from "node:path";
import { link, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  readOperationManifest,
  writeOperationManifestCreateOnly,
} from "../../src/operation-bundles/manifest-store.js";
import { operationPaths } from "../../src/operation-bundles/paths.js";
import type { BundleId, OperationRunId } from "../../src/operation-bundles/ids.js";
import type { OperationBundleManifest } from "../../src/operation-bundles/types.js";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const root = useTempRoot();
const BUNDLE = "bnd_01J00000000000000000000000" as BundleId;
const RUN = "opr_01J00000000000000000000000" as OperationRunId;
const DIGEST = `sha256:${"a".repeat(64)}` as const;

/** Build one complete immutable manifest with no executable behavior. */
function manifest(overrides: Partial<OperationBundleManifest> = {}): OperationBundleManifest {
  return {
    schemaVersion: 1, bundleId: BUNDLE, runId: RUN, workspaceId: "research",
    createdAt: "2026-07-18T12:00:00.000Z", createdBy: "planner",
    knowledgeAuthority: { id: "knowledge", digest: DIGEST },
    operationsAuthority: {
      packId: "pack", packDigest: DIGEST, actionId: "prepare",
      actionDescriptorDigest: DIGEST,
    },
    grantDigest: DIGEST, safetyFloorDigest: DIGEST, inputs: [],
    preparationEvidence: [], bounds: [], completeness: {
      attempted: 0, completed: 0, skipped: 0, failed: 0,
      requiredMissing: 0, optionalMissing: 0, rationaleDigest: DIGEST,
    },
    reconciliations: [], mutations: [], planningWarnings: [], ...overrides,
  };
}

describe("operation manifest store", () => {
  it("publishes canonical bytes create-only and exactly replays them", async () => {
    const value = manifest();

    await expect(writeOperationManifestCreateOnly(root.dir, value)).resolves.toBe("created");
    await expect(writeOperationManifestCreateOnly(root.dir, value)).resolves.toBe("same");

    const file = operationPaths(root.dir, value.workspaceId).manifestFile(value.bundleId);
    expect(await readFile(file)).toEqual(canonicalBytes(value));
    await expect(readOperationManifest(root.dir, value.workspaceId, value.bundleId))
      .resolves.toEqual({ status: "ok", manifest: value });
  });

  it("refuses replacement when immutable bytes already differ", async () => {
    const value = manifest();
    await writeOperationManifestCreateOnly(root.dir, value);

    const changed = manifest({ planningWarnings: [{ code: "changed", message: "changed" }] });
    await expect(writeOperationManifestCreateOnly(root.dir, changed))
      .rejects.toThrow(/manifest.*conflict|already exists/i);

    const read = await readOperationManifest(root.dir, value.workspaceId, value.bundleId);
    expect(read).toEqual({ status: "ok", manifest: value });
  });

  it("distinguishes absent, noncanonical invalid, and unavailable leaves", async () => {
    await expect(readOperationManifest(root.dir, "research", BUNDLE))
      .resolves.toEqual({ status: "absent" });
    const paths = operationPaths(root.dir, "research");
    await mkdir(paths.bundleRoot(BUNDLE), { recursive: true });
    await writeFile(paths.manifestFile(BUNDLE), Buffer.concat([canonicalBytes(manifest()), Buffer.from("\n")]));
    await expect(readOperationManifest(root.dir, "research", BUNDLE))
      .resolves.toMatchObject({ status: "invalid" });

    await writeFile(path.join(root.dir, "outside-manifest"), canonicalBytes(manifest()));
    await writeFile(paths.manifestFile(BUNDLE), "replace-me");
    await import("node:fs/promises").then(({ rm }) => rm(paths.manifestFile(BUNDLE)));
    await symlink(path.join(root.dir, "outside-manifest"), paths.manifestFile(BUNDLE));
    await expect(readOperationManifest(root.dir, "research", BUNDLE))
      .resolves.toMatchObject({ status: "unavailable" });
  });

  it("rejects a manifest whose embedded identity does not match its leaf", async () => {
    const other = "bnd_01J00000000000000000000001" as BundleId;
    const paths = operationPaths(root.dir, "research");
    await mkdir(paths.bundleRoot(BUNDLE), { recursive: true });
    await writeFile(paths.manifestFile(BUNDLE), canonicalBytes(manifest({ bundleId: other })));

    const read = await readOperationManifest(root.dir, "research", BUNDLE);
    expect(read).toMatchObject({ status: "invalid" });
    expect(read.status === "invalid" ? read.detail : "").toMatch(/binding|identity/i);
  });

  it("refuses a manifest inode with a non-protocol hard-link alias", async () => {
    const value = manifest();
    await writeOperationManifestCreateOnly(root.dir, value);
    const file = operationPaths(root.dir, value.workspaceId).manifestFile(value.bundleId);
    await link(file, path.join(root.dir, "foreign-manifest-alias"));

    await expect(readOperationManifest(root.dir, value.workspaceId, value.bundleId))
      .resolves.toMatchObject({ status: "unavailable" });
  });
});

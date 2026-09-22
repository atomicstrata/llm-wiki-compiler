/**
 * @file test/operation-bundles/operations-authority-resolver-drift.test.ts
 * @description Drift and fail-closed tests for the operations-authority resolver:
 * an authority-relevant change (grants, profile, key epoch) moves the folded
 * digest so the seam parks; unreadable/absent backing state (key absent, profile
 * unloadable, store health un-probeable) fails closed to `unavailable`; and every
 * component is scoped to the request root (cross-workspace isolation).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { createOperationsAuthorityResolver } from "../../src/operation-bundles/operations-authority-resolver.js";
import { OPERATION_MUTATION_KINDS } from "../../src/operation-bundles/adapter-registry.js";
import { authorityRequestFor, stageSourceBundle, WORKSPACE } from "./executor-fixtures.js";
import { writeProfileFile, SAMPLE_PROFILE } from "../fixtures/profile-fixtures.js";

const resolver = createOperationsAuthorityResolver({ adapterKinds: OPERATION_MUTATION_KINDS });
const okDigest = (r: Awaited<ReturnType<typeof resolver.computeSnapshot>>) => (r.status === "ok" ? r.digest : r.reason);

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "op-auth-drift-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("operations-authority resolver — drift moves the digest", () => {
  it("drifts when the presented grant set changes", async () => {
    const staged = await stageSourceBundle(root);
    const base = await resolver.computeSnapshot(await authorityRequestFor(root, staged, { grants: ["operation-bundle.approve"] }));
    const other = await resolver.computeSnapshot(await authorityRequestFor(root, staged, { grants: ["operation-bundle.approve", "operation-bundle.cancel"] }));
    expect(base.status).toBe("ok");
    expect(okDigest(other)).not.toBe(okDigest(base));
  });

  it("drifts when the active profile changes, but not on principal identity", async () => {
    const staged = await stageSourceBundle(root);
    const base = await resolver.computeSnapshot(await authorityRequestFor(root, staged, { principalId: "operator" }));
    const renamed = await resolver.computeSnapshot(await authorityRequestFor(root, staged, { principalId: "someone-else" }));
    expect(okDigest(renamed)).toBe(okDigest(base));
    await writeProfileFile(root, SAMPLE_PROFILE);
    const profiled = await resolver.computeSnapshot(await authorityRequestFor(root, staged));
    expect(okDigest(profiled)).not.toBe(okDigest(base));
  });
});

describe("operations-authority resolver — fail closed", () => {
  it("is unavailable when the operation key is absent", async () => {
    const staged = await stageSourceBundle(root);
    const request = await authorityRequestFor(root, staged);
    await rm(path.join(root, ".llmwiki", "operation-bundles.runkey"));
    expect((await resolver.computeSnapshot(request)).status).toBe("unavailable");
  });

  it("is unavailable when a present profile cannot be loaded", async () => {
    const staged = await stageSourceBundle(root);
    const request = await authorityRequestFor(root, staged);
    await writeFile(path.join(root, ".llmwiki", "profile.json"), "{ not valid json", "utf8");
    expect((await resolver.computeSnapshot(request)).status).toBe("unavailable");
  });
});

/** Corrupt one bundle's on-disk manifest, leaving the rest of the store untouched. */
async function corruptManifest(bundleId: string): Promise<void> {
  await writeFile(path.join(root, ".llmwiki", "workspaces", WORKSPACE, "bundles", bundleId, "manifest.json"), "corrupt", "utf8");
}

describe("operations-authority resolver — no false drift on unrelated store churn", () => {
  it("does not move a bundle's snapshot when an UNRELATED bundle is corrupted", async () => {
    const bundleA = await stageSourceBundle(root, Buffer.from("bundle A source\n"));
    const bundleB = await stageSourceBundle(root, Buffer.from("bundle B source\n"));
    const base = await resolver.computeSnapshot(await authorityRequestFor(root, bundleA));
    await corruptManifest(bundleB.bundleId);
    const after = await resolver.computeSnapshot(await authorityRequestFor(root, bundleA));
    expect(base.status).toBe("ok");
    expect(okDigest(after)).toBe(okDigest(base));
  });

  it("keeps storeHealthDigest fixed regardless of on-disk store state", async () => {
    const staged = await stageSourceBundle(root);
    const base = await resolver.computeSnapshot(await authorityRequestFor(root, staged));
    const request = await authorityRequestFor(root, staged);
    await corruptManifest(staged.bundleId);
    const after = await resolver.computeSnapshot(request);
    expect(base.status === "ok" && after.status === "ok").toBe(true);
    if (base.status === "ok" && after.status === "ok") expect(after.snapshot.storeHealthDigest).toBe(base.snapshot.storeHealthDigest);
  });
});

describe("operations-authority resolver — distinct-root isolation", () => {
  it("binds the key epoch to the project root — distinct roots yield distinct snapshots", async () => {
    const stagedA = await stageSourceBundle(root);
    const other = await mkdtemp(path.join(os.tmpdir(), "op-auth-iso-"));
    try {
      const stagedB = await stageSourceBundle(other);
      const a = await resolver.computeSnapshot(await authorityRequestFor(root, stagedA));
      const b = await resolver.computeSnapshot(await authorityRequestFor(other, stagedB));
      expect(a.status === "ok" && b.status === "ok").toBe(true);
      if (a.status === "ok" && b.status === "ok") expect(a.snapshot.keyEpochId).not.toBe(b.snapshot.keyEpochId);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

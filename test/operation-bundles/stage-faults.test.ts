/**
 * @file test/operation-bundles/stage-faults.test.ts
 * @description Crash-boundary staging tests. Durable payload-only and
 * manifest-only remnants stay inert, visible, and capacity-counted.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { link, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { scanOperationInventory } from "../../src/operation-bundles/capacity.js";
import { operationPaths } from "../../src/operation-bundles/paths.js";
import {
  stageOperationBundleLocked,
  type OperationBundleDraft,
  type StageOperationBundleRequest,
} from "../../src/operation-bundles/stage.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import type { BundleId, OperationRunId } from "../../src/operation-bundles/ids.js";
import {
  MAX_ACTIVE_BUNDLE_BYTES, MAX_PENDING_BUNDLES,
} from "../../src/operation-bundles/constants.js";

const root = useTempRoot();
const DIGEST = `sha256:${"a".repeat(64)}` as const;
const AT = "2026-07-18T12:00:00.000Z";

/** Return the fixed authority fields shared by crash fixtures. */
function authority() {
  return {
    createdBy: "planner",
    knowledgeAuthority: { id: "knowledge", digest: DIGEST },
    operationsAuthority: { packId: "pack", packDigest: DIGEST,
      actionId: "prepare", actionDescriptorDigest: DIGEST },
    grantDigest: DIGEST,
    safetyFloorDigest: DIGEST,
  };
}

/** Materialize retained-source mutations from exact payload bytes. */
function mutations(payloads: readonly Buffer[]) {
  return payloads.map((bytes) => {
    const payloadRef = createHash("sha256").update(bytes).digest("hex");
    const bound = `sha256:${payloadRef}` as const;
    return {
      kind: "source-retain" as const, operation: "create" as const,
      payloadRef, postcondition: { digest: bound, byteCount: bytes.length },
      target: { digest: payloadRef }, dependsOn: [], reconciliationRefs: [],
      precondition: {
        kind: "absent-or-same" as const, digest: bound, byteCount: bytes.length,
      },
    };
  });
}

/** Build a complete internal draft for one or more payloads. */
function draft(payloads: readonly Buffer[]): OperationBundleDraft {
  return {
    workspaceId: "research", ...authority(), inputs: [], preparationEvidence: [], bounds: [],
    completeness: { attempted: 0, completed: 0, skipped: 0, failed: 0,
      requiredMissing: 0, optionalMissing: 0, rationaleDigest: DIGEST },
    reconciliations: [], planningWarnings: [], mutations: mutations(payloads),
    run: {
      actor: { id: "planner", surface: "sdk", grants: [] },
      declaredCompensatorIndexes: [], controlTransitionAllowance: 32,
    },
  };
}

/** Build one request with private payload snapshots and an injected fault. */
function request(
  payloads: readonly Buffer[],
  faultsForTest: NonNullable<StageOperationBundleRequest["faultsForTest"]> = {},
): StageOperationBundleRequest {
  return {
    draft: draft(payloads),
    payloads: new Map(payloads.map((bytes) => [
      createHash("sha256").update(bytes).digest("hex"), Buffer.from(bytes),
    ])),
    clock: { now: () => new Date(AT) }, faultsForTest,
  };
}

type TerminalFaultSeam = "afterManifestSync" | "beforeInitialRunSync" | "afterInitialRunSync";

/** Stage through one terminal seam and return the inventory left by its fault. */
async function inventoryAfterFault(bytes: string, seam: TerminalFaultSeam) {
  const failure = new Error(seam);
  const staged = request([Buffer.from(bytes)], {
    [seam]: async () => { throw failure; },
  });
  await expect(stageOperationBundleLocked(root.dir, staged)).rejects.toBe(failure);
  return scanOperationInventory(root.dir);
}

/** Complete one fixed-ID retry and require healthy pending classification. */
async function expectSuccessfulRetry(bytes: string, idsForTest: {
  bundleId: BundleId; runId: OperationRunId;
}): Promise<void> {
  const replay = { ...request([Buffer.from(bytes)], {}), idsForTest };
  await expect(stageOperationBundleLocked(root.dir, replay)).resolves.toMatchObject({ wrote: true });
  await expect(scanOperationInventory(root.dir)).resolves.toMatchObject({
    pendingBundles: 1, problems: [], epoch: { orphans: { count: 0 } },
  });
}

/** Return payload, manifest, and run leaves in publication order. */
function stagedLeaves(result: Awaited<ReturnType<typeof stageOperationBundleLocked>>): string[] {
  const mutation = result.manifest.mutations[0]!;
  if (!("payloadRef" in mutation)) throw new Error("fixture requires payload mutation");
  const paths = operationPaths(root.dir, result.manifest.workspaceId);
  return [
    paths.payloadFile(result.manifest.bundleId, mutation.payloadRef),
    paths.manifestFile(result.manifest.bundleId),
    paths.runFile(result.manifest.runId),
  ];
}

/** Move authoritative leaves into one alias-only crash state. */
async function aliasOnly(leaves: readonly string[], suffix: string): Promise<void> {
  for (const leaf of leaves) await rename(leaf, `${leaf}${suffix}`);
}

/** Require final leaves settled and every reserved alias removed. */
async function expectSettled(leaves: readonly string[]): Promise<void> {
  for (const leaf of leaves) {
    await expect(stat(leaf)).resolves.toMatchObject({ nlink: 1 });
    await expect(stat(`${leaf}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(`${leaf}.writing`)).rejects.toMatchObject({ code: "ENOENT" });
  }
}

/** Fill quarantine so the currently inventoried physical bytes meet the cap. */
async function holdAtActiveCap(label: string): Promise<void> {
  const inventory = await scanOperationInventory(root.dir);
  const held = path.join(operationPaths(root.dir, "research").quarantineRoot, label, "bytes");
  await mkdir(path.dirname(held), { recursive: true });
  const handle = await open(held, "w");
  await handle.truncate(MAX_ACTIVE_BUNDLE_BYTES - inventory.activeBytes);
  await handle.close();
}

/** Retry one staged candidate with its exact original identities. */
async function retryStaged(
  staged: Awaited<ReturnType<typeof stageOperationBundleLocked>>,
  bytes: Buffer,
): Promise<void> {
  await expect(stageOperationBundleLocked(root.dir, {
    ...request([bytes], {}), idsForTest: {
      bundleId: staged.manifest.bundleId, runId: staged.manifest.runId,
    },
  })).resolves.toMatchObject({ wrote: true });
}

describe("operation bundle staging crash boundaries", () => {
  it.each([0, 1])("leaves only synced payloads inert after payload fault %i", async (stop) => {
    const payloads = [Buffer.from("first"), Buffer.from("second")];
    const failure = new Error(`payload fault ${stop}`);
    const staged = request(payloads, {
      afterPayloadSync: async (index) => { if (index === stop) throw failure; },
    });

    await expect(stageOperationBundleLocked(root.dir, staged)).rejects.toBe(failure);
    const inventory = await scanOperationInventory(root.dir);
    expect(inventory.epoch.payloads.count).toBe(stop + 1);
    expect(inventory.epoch.runs.count).toBe(0);
    expect(inventory.epoch.orphans).toMatchObject({ count: 1, health: "ok" });
    expect(inventory.activeBytes).toBeGreaterThan(0);
  });

  it("resumes an exact payload-only retry and charges the missing manifest and run", async () => {
    const failure = new Error("payload only");
    const idsForTest = {
      bundleId: "bnd_01J00000000000000000000010" as BundleId,
      runId: "opr_01J00000000000000000000010" as OperationRunId,
    };
    const staged = { ...request([Buffer.from("resume payload")], {
      afterPayloadSync: async () => { throw failure; },
    }), idsForTest };
    await expect(stageOperationBundleLocked(root.dir, staged)).rejects.toBe(failure);

    await expectSuccessfulRetry("resume payload", idsForTest);
  });

  it("resumes an exact manifest-only retry and publishes only the missing run", async () => {
    const failure = new Error("manifest only");
    const idsForTest = {
      bundleId: "bnd_01J00000000000000000000011" as BundleId,
      runId: "opr_01J00000000000000000000011" as OperationRunId,
    };
    const staged = { ...request([Buffer.from("resume manifest")], {
      afterManifestSync: async () => { throw failure; },
    }), idsForTest };
    await expect(stageOperationBundleLocked(root.dir, staged)).rejects.toBe(failure);

    await expectSuccessfulRetry("resume manifest", idsForTest);
  });

  it("refuses a missing-payload retry at the active cap before restoring bytes", async () => {
    const failure = new Error("manifest durable"), bytes = Buffer.from("missing payload");
    const idsForTest = {
      bundleId: "bnd_01J00000000000000000000012" as BundleId,
      runId: "opr_01J00000000000000000000012" as OperationRunId,
    };
    const staged = { ...request([bytes], { afterManifestSync: async () => { throw failure; } }), idsForTest };
    await expect(stageOperationBundleLocked(root.dir, staged)).rejects.toBe(failure);
    const paths = operationPaths(root.dir, "research"), payloadRef = mutations([bytes])[0]!.payloadRef;
    const payload = paths.payloadFile(idsForTest.bundleId, payloadRef);
    await unlink(payload);
    const manifest = paths.manifestFile(idsForTest.bundleId), manifestBytes = await readFile(manifest);
    const held = path.join(paths.quarantineRoot, "active-cap", "bytes", "part");
    await mkdir(path.dirname(held), { recursive: true });
    const handle = await open(held, "w");
    await handle.truncate(MAX_ACTIVE_BUNDLE_BYTES - manifestBytes.byteLength);
    await handle.close();

    const replay = { ...request([bytes], {}), idsForTest };
    await expect(stageOperationBundleLocked(root.dir, replay)).rejects.toThrow(/active-bytes.*cap/i);
    await expect(stat(payload)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(manifest)).toEqual(manifestBytes);
    await expect(stat(paths.runFile(idsForTest.runId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a manifest-only retry when its pending increment exceeds the cap", async () => {
    for (let index = 0; index < MAX_PENDING_BUNDLES - 1; index++) {
      await stageOperationBundleLocked(root.dir, request([Buffer.from(`pending-${index}`)], {}));
    }
    const failure = new Error("pending manifest"), bytes = Buffer.from("pending retry");
    const idsForTest = {
      bundleId: "bnd_01J00000000000000000000013" as BundleId,
      runId: "opr_01J00000000000000000000013" as OperationRunId,
    };
    const staged = { ...request([bytes], { afterManifestSync: async () => { throw failure; } }), idsForTest };
    await expect(stageOperationBundleLocked(root.dir, staged)).rejects.toBe(failure);
    await stageOperationBundleLocked(root.dir, request([Buffer.from("pending-final")], {}));
    const paths = operationPaths(root.dir, "research");
    const manifest = paths.manifestFile(idsForTest.bundleId), before = await readFile(manifest);

    await expect(stageOperationBundleLocked(root.dir, { ...request([bytes], {}), idsForTest }))
      .rejects.toThrow(/pending-bundles.*cap/i);
    expect(await readFile(manifest)).toEqual(before);
    await expect(stat(paths.runFile(idsForTest.runId))).rejects.toMatchObject({ code: "ENOENT" });
    // Near-cap loop: every staging call re-verifies all prior final leaves
    // (F-P1 inventory authentication), so this worst case is quadratic by design.
  }, 120_000);

  it.each(["afterManifestSync", "beforeInitialRunSync"] as const)(
    "keeps manifest-without-run inert after %s",
    async (seam) => {
      const inventory = await inventoryAfterFault("manifest orphan", seam);
      expect(inventory.epoch.bundles.count).toBe(1);
      expect(inventory.epoch.runs.count).toBe(0);
      expect(inventory.epoch.orphans).toMatchObject({ count: 1, health: "ok" });
      expect(inventory.activeBytes).toBeGreaterThan(Buffer.byteLength("manifest orphan"));
    },
  );

  it("classifies an after-run-sync fault as a complete pending bundle", async () => {
    const inventory = await inventoryAfterFault("complete", "afterInitialRunSync");
    expect(inventory.epoch).toMatchObject({
      bundles: { count: 1, health: "ok" }, runs: { count: 1, health: "ok" },
      orphans: { count: 0, bytes: 0, health: "ok" },
    });
    expect(inventory.pendingBundles).toBe(1);
  });

  it("allows a later in-bounds stage while counting a prior inert orphan", async () => {
    const failure = new Error("first payload synced");
    await expect(stageOperationBundleLocked(root.dir, request([Buffer.from("orphan")], {
      afterPayloadSync: async () => { throw failure; },
    }))).rejects.toBe(failure);

    const clean = request([Buffer.from("healthy")], {});
    await expect(stageOperationBundleLocked(root.dir, clean)).resolves.toMatchObject({ wrote: true });
    const inventory = await scanOperationInventory(root.dir);
    expect(inventory.epoch.orphans.count).toBe(1);
    expect(inventory.pendingBundles).toBe(1);
  });

  it.each([".tmp", ".writing"])(
    "accepts exact reserved %s aliases for staged payload, manifest, and run leaves",
    async (suffix) => {
      const staged = await stageOperationBundleLocked(root.dir, request([Buffer.from(suffix)]));
      const mutation = staged.manifest.mutations[0]!;
      if (!("payloadRef" in mutation)) throw new Error("fixture requires payload mutation");
      const paths = operationPaths(root.dir, staged.manifest.workspaceId);
      const leaves = [
        paths.payloadFile(staged.manifest.bundleId, mutation.payloadRef),
        paths.manifestFile(staged.manifest.bundleId),
        paths.runFile(staged.manifest.runId),
      ];
      for (const leaf of leaves) await link(leaf, `${leaf}${suffix}`);

      const inventory = await scanOperationInventory(root.dir);
      expect(inventory.problems).toEqual([]);
      await expect(stageOperationBundleLocked(root.dir, request([Buffer.from(`next${suffix}`)])))
        .resolves.toMatchObject({ wrote: true });
    },
  );

  it.each([".tmp", ".writing"])(
    "resumes and settles alias-only %s payload, manifest, and run leaves",
    async (suffix) => {
      const bytes = Buffer.from(`alias-only${suffix}`);
      const staged = await stageOperationBundleLocked(root.dir, request([bytes], {}));
      const leaves = stagedLeaves(staged);
      await aliasOnly(leaves, suffix);
      const idsForTest = {
        bundleId: staged.manifest.bundleId, runId: staged.manifest.runId,
      };

      await expect(stageOperationBundleLocked(root.dir, {
        ...request([bytes], {}), idsForTest,
      })).resolves.toMatchObject({ wrote: true });
      await expectSettled(leaves);
    },
  );

  it("refuses a conflicting manifest alias before replacing an earlier payload scratch", async () => {
    const bytes = Buffer.from("manifest alias conflict");
    const staged = await stageOperationBundleLocked(root.dir, request([bytes], {}));
    const leaves = stagedLeaves(staged), payload = leaves[0]!, manifest = leaves[1]!;
    await rename(payload, `${payload}.writing`);
    await rename(manifest, `${manifest}.tmp`);
    await writeFile(`${manifest}.tmp`, "conflicting manifest");
    const before = await readFile(`${payload}.writing`);

    await expect(stageOperationBundleLocked(root.dir, {
      ...request([bytes], {}), idsForTest: {
        bundleId: staged.manifest.bundleId, runId: staged.manifest.runId,
      },
    })).rejects.toThrow(/manifest.*identity conflict/i);
    expect(await readFile(`${payload}.writing`)).toEqual(before);
    await expect(stat(payload)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a later-sorted payload alias conflict without replacing an earlier scratch", async () => {
    const bytes = [Buffer.from("sorted payload one"), Buffer.from("sorted payload two")];
    const staged = await stageOperationBundleLocked(root.dir, request(bytes, {}));
    const paths = operationPaths(root.dir, staged.manifest.workspaceId);
    const digests = [...staged.manifest.mutations].map((item) => {
      if (!("payloadRef" in item)) throw new Error("fixture requires payload mutation");
      return item.payloadRef;
    }).sort();
    const first = paths.payloadFile(staged.manifest.bundleId, digests[0]!);
    const later = paths.payloadFile(staged.manifest.bundleId, digests[1]!);
    await rename(first, `${first}.writing`);
    await rename(later, `${later}.tmp`);
    await writeFile(`${later}.tmp`, "conflicting later payload");
    const before = await readFile(`${first}.writing`);

    await expect(stageOperationBundleLocked(root.dir, {
      ...request(bytes, {}), idsForTest: {
        bundleId: staged.manifest.bundleId, runId: staged.manifest.runId,
      },
    })).rejects.toThrow(/payload identity conflict/i);
    expect(await readFile(`${first}.writing`)).toEqual(before);
    await expect(stat(first)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("promotes exact ready aliases at the active-byte cap without double charging", async () => {
    const bytes = Buffer.from("zero-growth ready aliases");
    const staged = await stageOperationBundleLocked(root.dir, request([bytes], {}));
    const leaves = stagedLeaves(staged);
    await aliasOnly(leaves, ".tmp");
    await holdAtActiveCap("ready-cap");

    await retryStaged(staged, bytes);
    await expectSettled(leaves);
  });

  it("credits disposable scratch removal before charging its smaller replacement", async () => {
    const bytes = Buffer.from("small replacement");
    const staged = await stageOperationBundleLocked(root.dir, request([bytes], {}));
    const leaves = stagedLeaves(staged), payload = leaves[0]!;
    await rename(payload, `${payload}.writing`);
    await writeFile(`${payload}.writing`, Buffer.alloc(1024 * 1024, 0x61));
    await holdAtActiveCap("scratch-cap");

    await retryStaged(staged, bytes);
    await expectSettled(leaves);
    expect(await readFile(payload)).toEqual(bytes);
  });
});

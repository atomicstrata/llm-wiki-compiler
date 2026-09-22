/**
 * @file test/operation-bundles/run-store-durability.test.ts
 * @description Filesystem proofs for distinct key states, empty-epoch creation,
 * confined no-follow reads, and durable complete operation-run replacement.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { chmod, copyFile, link, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { mintBundleId, mintOperationRunId, mutationId } from "../../src/operation-bundles/ids.js";
import { operationPaths } from "../../src/operation-bundles/paths.js";
import {
  createOperationKeyForEmptyEpochLocked,
  readOperationKey,
  type OperationEpochInventory,
} from "../../src/operation-bundles/key-epoch.js";
import { operationRunPredecessor } from "../../src/operation-bundles/run-integrity.js";
import {
  appendControlTransition,
  appendAbandonedTransitionLocked,
  appendOperationTransitionLocked,
  appendRecoveredTransitionLocked,
  createOperationRunLocked,
  readOperationRun,
} from "../../src/operation-bundles/run-store.js";
import type { OperationPrincipal } from "../../src/operation-bundles/principal.js";
import { runFixture as makeRunFixture } from "./run-fixture.js";
import { atomicWriteNoReplaceDurable } from "../../src/utils/atomic-write.js";
import { readConfinedLeaf } from "../../src/utils/confined-read.js";

const EMPTY_INVENTORY: OperationEpochInventory = {
  bundles: { count: 0, bytes: 0, health: "ok" }, runs: { count: 0, bytes: 0, health: "ok" },
  payloads: { count: 0, bytes: 0, health: "ok" }, evidence: { count: 0, bytes: 0, health: "ok" },
  cancelRequests: { count: 0, bytes: 0, health: "ok" }, orphans: { count: 0, bytes: 0, health: "ok" },
};
const ACTOR: OperationPrincipal = { id: "operator", surface: "cli", grants: [] };
const DIGEST = `sha256:${"9".repeat(64)}` as const;
const AT = "2026-07-17T02:00:00.000Z";
const OWNER = { pid: 515, processStartTime: AT };
let root: string;

beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "operation-run-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** Create one keyed run fixture and its exact workspace store paths. */
async function runFixture(authoritativeMutationCount = 0) {
  const created = await createOperationKeyForEmptyEpochLocked(root, EMPTY_INVENTORY);
  const fixture = makeRunFixture({ key: created.key, actor: ACTOR, at: AT, authoritativeMutationCount });
  return { ...fixture, paths: operationPaths(root, "default") };
}

describe("operation key epoch", () => {
  it("distinguishes absent, unavailable, and ok without read-side creation", async () => {
    expect(await readOperationKey(root)).toEqual({ status: "absent" });
    expect(await readdir(root)).toEqual([]);
    const keyFile = path.join(root, ".llmwiki", "operation-bundles.runkey");
    await mkdir(path.dirname(keyFile), { recursive: true });
    await symlink(path.join(root, "outside-key"), keyFile);
    expect(await readOperationKey(root)).toEqual({ status: "unavailable" });
    await rm(keyFile);
    const created = await createOperationKeyForEmptyEpochLocked(root, EMPTY_INVENTORY);
    await expect(readOperationKey(root)).resolves.toMatchObject({ status: "ok", keyEpochId: created.keyEpochId });
  });

  it("creates a 32-byte key at mode 0600 only for an empty epoch", async () => {
    await expect(createOperationKeyForEmptyEpochLocked(root, { ...EMPTY_INVENTORY, orphans: { count: 1, bytes: 0, health: "ok" } })).rejects.toThrow(/empty epoch/);
    const created = await createOperationKeyForEmptyEpochLocked(root, EMPTY_INVENTORY);
    const keyFile = path.join(root, ".llmwiki", "operation-bundles.runkey");
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
    const stored = Buffer.from(await readFile(keyFile, "utf8"), "base64");
    expect(stored).toHaveLength(32);
    expect(created.key).toEqual(stored);
  });

  it("refuses final and ready key inodes with external aliases", async () => {
    await createOperationKeyForEmptyEpochLocked(root, EMPTY_INVENTORY);
    const keyFile = path.join(root, ".llmwiki", "operation-bundles.runkey");
    await link(keyFile, path.join(root, "external-key-alias"));
    expect(await readOperationKey(root)).toEqual({ status: "unavailable" });

    await rm(path.join(root, ".llmwiki"), { recursive: true });
    const readyFile = `${keyFile}.tmp`;
    await mkdir(path.dirname(keyFile), { recursive: true });
    await writeFile(readyFile, Buffer.alloc(32, 0x5a).toString("base64"), { mode: 0o600 });
    await link(readyFile, path.join(root, "external-ready-key-alias"));
    await expect(createOperationKeyForEmptyEpochLocked(root, EMPTY_INVENTORY))
      .rejects.toThrow(/recovery.*unavailable|link|alias/i);
  });

  it("adopts and promotes a crash-left ready key instead of minting replacement bytes", async () => {
    const keyFile = path.join(root, ".llmwiki", "operation-bundles.runkey");
    const readyFile = `${keyFile}.tmp`;
    const crashKey = Buffer.alloc(32, 0x5a);
    await mkdir(path.dirname(keyFile), { recursive: true });
    await writeFile(readyFile, crashKey.toString("base64"), { mode: 0o600 });

    const recovered = await createOperationKeyForEmptyEpochLocked(root, EMPTY_INVENTORY);

    expect(recovered.key).toEqual(crashKey);
    expect(Buffer.from(await readFile(keyFile, "utf8"), "base64")).toEqual(crashKey);
    await expect(stat(readyFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers the protocol-owned writing and ready key aliases", async () => {
    const keyFile = path.join(root, ".llmwiki", "operation-bundles.runkey");
    const readyFile = `${keyFile}.tmp`, writingFile = `${keyFile}.writing`;
    const crashKey = Buffer.alloc(32, 0x6b);
    await mkdir(path.dirname(keyFile), { recursive: true });
    await writeFile(writingFile, crashKey.toString("base64"), { mode: 0o600 });
    await link(writingFile, readyFile);

    const recovered = await createOperationKeyForEmptyEpochLocked(root, EMPTY_INVENTORY);

    expect(recovered.key).toEqual(crashKey);
    expect(await readdir(path.dirname(keyFile))).toEqual(["operation-bundles.runkey"]);
  });

  it("reclaims a committed ready alias before refusing an existing key epoch", async () => {
    await createOperationKeyForEmptyEpochLocked(root, EMPTY_INVENTORY);
    const keyFile = path.join(root, ".llmwiki", "operation-bundles.runkey");
    const readyFile = `${keyFile}.tmp`;
    await link(keyFile, readyFile);

    await expect(createOperationKeyForEmptyEpochLocked(root, EMPTY_INVENTORY))
      .rejects.toThrow(/epoch already exists/);

    await expect(stat(readyFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readOperationKey(root)).resolves.toMatchObject({ status: "ok" });
  });

  it("keeps active runs readable through the committed key alias crash state", async () => {
    const { binding, input } = await runFixture();
    await createOperationRunLocked(root, input);
    const keyFile = path.join(root, ".llmwiki", "operation-bundles.runkey");
    await link(keyFile, `${keyFile}.tmp`);

    await expect(readOperationKey(root)).resolves.toMatchObject({ status: "ok" });
    await expect(readOperationRun(root, binding)).resolves.toMatchObject({ status: "ok" });

    await link(keyFile, path.join(root, "external-key-alias"));
    await expect(readOperationKey(root)).resolves.toEqual({ status: "unavailable" });
  });

  it("does not mistake zero-byte objects or unavailable inventory for empty", async () => {
    const zeroByteRun = { ...EMPTY_INVENTORY, runs: { count: 1, bytes: 0, health: "ok" as const } };
    const unavailable = { ...EMPTY_INVENTORY, payloads: { count: 0, bytes: 0, health: "unavailable" as const } };
    await expect(createOperationKeyForEmptyEpochLocked(root, zeroByteRun)).rejects.toThrow(/empty epoch/);
    await expect(createOperationKeyForEmptyEpochLocked(root, unavailable)).rejects.toThrow(/empty epoch/);
  });

  it("rejects an over-permissive key and refuses a concurrent create collision", async () => {
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const beforePublishForTest = async () => { arrived += 1; if (arrived === 2) release(); await barrier; };
    const results = await Promise.allSettled([
      createOperationKeyForEmptyEpochLocked(root, EMPTY_INVENTORY, { beforePublishForTest }),
      createOperationKeyForEmptyEpochLocked(root, EMPTY_INVENTORY, { beforePublishForTest }),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
    const keyFile = path.join(root, ".llmwiki", "operation-bundles.runkey");
    await chmod(keyFile, 0o644);
    expect(await readOperationKey(root)).toEqual({ status: "unavailable" });
  });
});

describe("operation run durable store", () => {
  it("keeps an absent read side-effect free", async () => {
    const binding = { bundleId: mintBundleId(), runId: mintOperationRunId(), workspaceId: "default", manifestDigest: DIGEST, keyEpochId: DIGEST };
    expect(await readOperationRun(root, binding)).toEqual({ status: "absent" });
    expect(await readdir(root)).toEqual([]);
  });

  it("classifies a missing project key before an unverifiable active run", async () => {
    const runId = mintOperationRunId();
    const bundleId = mintBundleId();
    const paths = operationPaths(root, "default");
    await mkdir(paths.runsRoot, { recursive: true });
    await writeFile(paths.runFile(runId), "{}");
    const binding = { bundleId, runId, workspaceId: "default", manifestDigest: DIGEST, keyEpochId: DIGEST };
    await expect(readOperationRun(root, binding)).resolves.toMatchObject({ status: "unavailable", code: "integrity-key-missing" });
  });

  it("writes mode 0600, reads the exact binding, and leaves no temp leaf", async () => {
    const { binding, input, paths } = await runFixture();
    const written = await createOperationRunLocked(root, input);
    expect(written.integrity).toMatch(/^[0-9a-f]{64}$/);
    expect((await stat(paths.runFile(binding.runId))).mode & 0o777).toBe(0o600);
    await expect(readOperationRun(root, binding)).resolves.toMatchObject({ status: "ok", run: { runId: binding.runId } });
    expect(await readdir(paths.runsRoot)).toEqual([`${binding.runId}.json`]);
  });

  it("refuses a final run inode with an external alias", async () => {
    const { binding, input, paths } = await runFixture();
    await createOperationRunLocked(root, input);
    await link(paths.runFile(binding.runId), path.join(root, "external-run-alias"));

    await expect(readOperationRun(root, binding)).resolves.toMatchObject({
      status: "unavailable", detail: "run-leaf",
    });
  });

  it("rejects a symlinked exact workspace runs parent", async () => {
    const runId = mintOperationRunId();
    const bundleId = mintBundleId();
    const paths = operationPaths(root, "default");
    const outside = path.join(root, "outside-runs");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, `${runId}.json`), "{}");
    await mkdir(paths.workspaceRoot, { recursive: true });
    await symlink(outside, paths.runsRoot);
    const binding = { bundleId, runId, workspaceId: "default", manifestDigest: DIGEST, keyEpochId: DIGEST };
    await expect(readOperationRun(root, binding)).resolves.toMatchObject({ status: "unavailable" });
  });

  it("rejects whole-file HMAC tampering on read", async () => {
    const { binding, input, paths } = await runFixture();
    await createOperationRunLocked(root, input);
    const file = paths.runFile(binding.runId);
    const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...parsed, notices: [{ code: "tampered" }] }));
    await expect(readOperationRun(root, binding)).resolves.toMatchObject({ status: "unavailable" });
  });

  it("durably appends a fixed-shape recovery transition from reserved headroom", async () => {
    const { binding, input } = await runFixture();
    const written = await createOperationRunLocked(root, input);
    const parked = await appendControlTransition(root, binding, operationRunPredecessor(written), {
      type: "recovery-required", code: "run-record-headroom-exhausted", actor: ACTOR, at: AT,
    });
    expect(parked.state).toBe("recovery-required");
    expect(parked.transitions.at(-1)?.payload).toEqual({ kind: "problem", code: "run-record-headroom-exhausted" });
    await expect(readOperationRun(root, binding)).resolves.toMatchObject({ status: "ok", run: { state: "recovery-required" } });
  });

  it("keeps genesis create-only and refuses a stale append predecessor", async () => {
    const { binding, input } = await runFixture();
    const written = await createOperationRunLocked(root, input);
    await expect(createOperationRunLocked(root, input)).rejects.toThrow(/already exists/);
    const stale = { ...operationRunPredecessor(written), stateVersion: written.stateVersion + 1 };
    await expect(appendOperationTransitionLocked(root, binding, stale, {
      type: "approved", stateAfter: "approved", payload: { kind: "authority", authoritySnapshotDigest: DIGEST }, actor: ACTOR, at: AT,
    })).rejects.toThrow(/predecessor changed/);
  });

  it("rejects a copied run as a control target in another workspace", async () => {
    const { binding, input, paths } = await runFixture();
    const written = await createOperationRunLocked(root, input);
    const copiedPaths = operationPaths(root, "copied");
    await mkdir(copiedPaths.runsRoot, { recursive: true });
    await copyFile(paths.runFile(binding.runId), copiedPaths.runFile(binding.runId));
    const copiedBinding = { ...binding, workspaceId: "copied" };
    await expect(appendControlTransition(root, copiedBinding, operationRunPredecessor(written), {
      type: "recovery-required", code: "run-record-headroom-exhausted", actor: ACTOR, at: AT,
    })).rejects.toThrow(/binding|unavailable/);
  });

  it("treats ENOENT below an in-root redirected workspace as unavailable", async () => {
    const target = operationPaths(root, "target"), redirected = operationPaths(root, "redirected");
    await mkdir(target.runsRoot, { recursive: true });
    await symlink(target.workspaceRoot, redirected.workspaceRoot);
    const binding = { bundleId: mintBundleId(), runId: mintOperationRunId(), workspaceId: "redirected", manifestDigest: DIGEST, keyEpochId: DIGEST };
    await expect(readOperationRun(root, binding)).resolves.toMatchObject({ status: "unavailable" });
    await rm(redirected.workspaceRoot);
    await symlink(path.join(root, "missing-workspace"), redirected.workspaceRoot);
    await expect(readOperationRun(root, binding)).resolves.toMatchObject({ status: "unavailable" });
  });

  it("rejects an in-root cross-workspace parent redirect before run creation", async () => {
    const created = await createOperationKeyForEmptyEpochLocked(root, EMPTY_INVENTORY);
    const fixture = makeRunFixture({ key: created.key, actor: ACTOR, at: AT });
    const target = operationPaths(root, "target"), expected = operationPaths(root, "default");
    await mkdir(target.runsRoot, { recursive: true });
    await symlink(target.workspaceRoot, expected.workspaceRoot);
    await expect(createOperationRunLocked(root, fixture.input)).rejects.toThrow(/redirect|canonical/);
    await expect(readdir(target.runsRoot)).resolves.toEqual([]);
  });

  it("fails a bounded handle read when the opened file grows during the read", async () => {
    const dir = path.join(root, "bounded"), leaf = path.join(dir, "leaf");
    await mkdir(dir);
    await writeFile(leaf, "1234");
    const read = await readConfinedLeaf(root, leaf, dir, 4, { afterOpenForTest: async () => { await writeFile(leaf, "12345"); } });
    expect(read).toEqual({ kind: "unavailable" });
    await writeFile(leaf, "safe");
    const decoy = path.join(dir, "decoy");
    const swapped = await readConfinedLeaf(root, leaf, dir, 4, { beforePostReadCheckForTest: async () => {
      await writeFile(decoy, "evil");
      await rename(decoy, leaf);
    } });
    expect(swapped).toEqual({ kind: "unavailable" });
  });

  it("strict create-only durability syncs every parent and propagates unsupported sync", async () => {
    const synced: string[] = [];
    const target = path.join(root, "a", "b", "record");
    await atomicWriteNoReplaceDurable(target, "body", { confineRoot: root, exactParent: true, beforeDirectorySyncForTest: async (dir) => { synced.push(dir); } });
    const chain = [path.join(root, "a", "b"), path.join(root, "a"), root];
    expect(synced).toEqual([...chain, ...chain, ...chain]);
    const failure = Object.assign(new Error("unsupported fsync"), { code: "ENOTSUP" });
    await expect(atomicWriteNoReplaceDurable(path.join(root, "failed"), "body", {
      confineRoot: root, exactParent: true, beforeDirectorySyncForTest: async () => { throw failure; },
    })).rejects.toBe(failure);
  });

  it("settles recovered only from the authenticated successful recovery bundle", async () => {
    const created = await createOperationKeyForEmptyEpochLocked(root, EMPTY_INVENTORY);
    const original = makeRunFixture({ key: created.key, actor: ACTOR, at: AT });
    let originalRun = await createOperationRunLocked(root, original.input);
    originalRun = await appendControlTransition(root, original.binding, operationRunPredecessor(originalRun), {
      type: "recovery-required", code: "run-record-headroom-exhausted", actor: ACTOR, at: AT,
    });
    const recovery = makeRunFixture({ key: created.key, actor: ACTOR, at: AT, recoversBundleId: original.bundleId });
    let recoveryRun = await createOperationRunLocked(root, recovery.input);
    await expect(appendRecoveredTransitionLocked(root, original.binding, operationRunPredecessor(originalRun), {
      actor: ACTOR, at: AT, recoveryBinding: recovery.binding, recoveryExpected: operationRunPredecessor(recoveryRun), recoveryManifest: recovery.manifest,
    })).rejects.toThrow(/successful terminal/);
    recoveryRun = await appendOperationTransitionLocked(root, recovery.binding, operationRunPredecessor(recoveryRun), {
      type: "approved", stateAfter: "approved", payload: { kind: "authority", authoritySnapshotDigest: DIGEST }, actor: ACTOR, at: AT,
    });
    recoveryRun = await appendOperationTransitionLocked(root, recovery.binding, operationRunPredecessor(recoveryRun), {
      type: "apply-started", stateAfter: "applying", payload: { kind: "execution", authoritySnapshotDigest: DIGEST, applyOwner: OWNER }, actor: ACTOR, at: AT,
    });
    recoveryRun = await appendOperationTransitionLocked(root, recovery.binding, operationRunPredecessor(recoveryRun), {
      type: "succeeded", stateAfter: "succeeded", payload: { kind: "none" }, actor: ACTOR, at: AT,
    });
    const settled = await appendRecoveredTransitionLocked(root, original.binding, operationRunPredecessor(originalRun), {
      actor: ACTOR, at: AT, recoveryBinding: recovery.binding, recoveryExpected: operationRunPredecessor(recoveryRun), recoveryManifest: recovery.manifest,
    });
    expect(settled.state).toBe("recovered");
  });

  it("persists abandonment only with a granted residual proof", async () => {
    const fixture = await runFixture(1);
    let run = await createOperationRunLocked(root, fixture.input);
    run = await appendControlTransition(root, fixture.binding, operationRunPredecessor(run), {
      type: "recovery-required", code: "run-record-headroom-exhausted", actor: ACTOR, at: AT,
    });
    const body = Buffer.from("evidence");
    const evidence = { digest: `sha256:${createHash("sha256").update(body).digest("hex")}` as const, byteCount: body.byteLength, type: "observation", provenance: "controller" };
    await mkdir(fixture.paths.evidenceRoot(fixture.runId), { recursive: true });
    await writeFile(fixture.paths.evidenceFile(fixture.runId, evidence.digest.slice("sha256:".length)), body);
    const abandoned = await appendAbandonedTransitionLocked(root, fixture.binding, operationRunPredecessor(run), {
      actor: { ...ACTOR, grants: ["operation-bundle.abandon"] }, at: AT,
      confirmResidualState: true, manifest: fixture.manifest,
      observations: [{ code: "residual", mutationId: mutationId(fixture.bundleId, 0), evidence }],
    });
    expect(abandoned).toMatchObject({ state: "abandoned", residualFindings: [{ authoritativeNamespace: "workspace-sources", evidence }] });
  });
});

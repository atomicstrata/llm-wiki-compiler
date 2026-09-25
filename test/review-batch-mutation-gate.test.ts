/**
 * Real recovery and candidate-store faults must block batch promotion before
 * live effects. Snapshot comparisons include the recovery records and candidate
 * files so a refusal cannot quietly consume either authority or pending work.
 */
import { expect, it, vi } from "vitest";
import { chmod, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import * as gate from "../src/operation-bundles/lock-gate.js";
import { quarantinePreparationRunLocked } from "../src/preparations/quarantine.js";
import { acquireLock, releaseLock } from "../src/utils/lock.js";
import { parkedSourceBundle } from "./operation-bundles/executor-fixtures.js";
import { LIFECYCLE_ACTOR, stagePreparation, tamperRun } from "./preparations/lifecycle-fixture.js";
import { snapshotTree } from "./fixtures/template-publish-distribution.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { approveBatch, stageBatchCandidate, useQuietBatchTests } from "./fixtures/review-batch.js";

const root = useTempRoot();
useQuietBatchTests();

it("enters the shared review gate and leaves a parked operation bundle and candidates unchanged", async () => {
  const candidate = await stageBatchCandidate(root.dir, "alpha");
  await parkedSourceBundle(root.dir);
  const before = await snapshotTree(root.dir);
  const acquire = vi.spyOn(gate, "acquireMutationLock");
  const result = await approveBatch(root.dir, candidate.id);
  expect(acquire).toHaveBeenCalledWith(root.dir, "review");
  expect(result.status).toBe("failed");
  expect(result.error).toContain("operation bundle recovery is required");
  expect(result.finalized).toBe(false);
  expect(await snapshotTree(root.dir)).toEqual(before);
  expect(await acquireLock(root.dir)).toBe(true);
  await releaseLock(root.dir);
});

it("leaves a preparation quarantine pending until its own recovery completes", async () => {
  const candidate = await stageBatchCandidate(root.dir, "alpha");
  const { binding } = await stagePreparation(root.dir);
  await tamperRun(root.dir, binding);
  await expect(quarantinePreparationRunLocked(root.dir, {
    binding, actor: LIFECYCLE_ACTOR, at: "2026-09-24T00:00:00.000Z", confirmResidualState: true,
    faults: { afterPlanned: async () => { throw new Error("crash after plan"); } },
  })).rejects.toThrow("crash after plan");
  const before = await snapshotTree(root.dir);
  const result = await approveBatch(root.dir, candidate.id);
  expect(result.status).toBe("failed");
  expect(result.finalized).toBe(false);
  expect(await snapshotTree(root.dir)).toEqual(before);
  expect(existsSync(path.join(root.dir, ".llmwiki/lock"))).toBe(false);
});

it.each(["archive-alias", "read-only"])("refuses %s candidate storage before creating page or intent", async kind => {
  const candidate = await stageBatchCandidate(root.dir, "alpha");
  const pending = path.join(root.dir, ".llmwiki/candidates");
  const file = path.join(pending, `${candidate.id}.json`);
  const before = await readFile(file);
  if (kind === "archive-alias") await symlink(pending, path.join(pending, "archive"));
  else await chmod(pending, 0o555);
  try {
    const result = await approveBatch(root.dir, candidate.id);
    expect(result.status).toBe("failed");
    expect(result.finalized).toBe(false);
    expect(await readFile(file)).toEqual(before);
    expect(existsSync(path.join(root.dir, "wiki/concepts/alpha.md"))).toBe(false);
    expect(existsSync(path.join(root.dir, ".llmwiki/review-embedding-intent.json"))).toBe(false);
  } finally {
    if (kind === "read-only") await chmod(pending, 0o755);
  }
});

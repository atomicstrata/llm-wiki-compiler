/**
 * @file test/operation-bundles/inventory-corruption.test.ts
 * @description F-P1 corruption regressions (2026-07-19 adjudication). Corrupt
 * final payload, run-evidence, and run leaves — including orphans and leaves
 * no manifest claims — must surface inventory problems and fail staging closed
 * before its first write, while `.tmp` recovery aliases stay recoverable.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanOperationInventory } from "../../src/operation-bundles/capacity.js";
import { mintBundleId, mintOperationRunId } from "../../src/operation-bundles/ids.js";
import { operationPaths } from "../../src/operation-bundles/paths.js";
import { stageOperationBundleLocked } from "../../src/operation-bundles/stage.js";
import { sourceStageRequest } from "./stage-capacity-fixtures.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const root = useTempRoot();

/** Stage one healthy bundle and return its manifest identities. */
async function stageHealthyBundle(): Promise<{ bundleId: string; runId: string }> {
  const staged = await stageOperationBundleLocked(
    root.dir, sourceStageRequest(Buffer.from("healthy source payload")));
  return { bundleId: staged.manifest.bundleId, runId: staged.manifest.runId };
}

/** Assert the corrupted store reports problems and refuses new staging. */
async function expectFailClosed(expectedDimension: string): Promise<void> {
  const inventory = await scanOperationInventory(root.dir);
  expect(inventory.problems.map((problem) => problem.dimension))
    .toContain(expectedDimension);
  await expect(stageOperationBundleLocked(
    root.dir, sourceStageRequest(Buffer.from("subsequent staging attempt")),
  )).rejects.toThrow(/operation inventory unavailable/);
}

/** Write garbage bytes under a valid content-address name. */
async function plantCorruptLeaf(file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.from("bytes that do not match their address"));
}

describe("operation inventory corruption fails closed (F-P1)", () => {
  it("flags a corrupt orphan payload with no manifest", async () => {
    await stageHealthyBundle();
    const paths = operationPaths(root.dir, "research");
    await plantCorruptLeaf(paths.payloadFile(mintBundleId(), "b".repeat(64)));
    await expectFailClosed("payload-state");
  });

  it("flags a corrupt payload the owning manifest never claimed", async () => {
    const { bundleId } = await stageHealthyBundle();
    const paths = operationPaths(root.dir, "research");
    await plantCorruptLeaf(paths.payloadFile(bundleId as never, "c".repeat(64)));
    await expectFailClosed("payload-state");
  });

  it("flags a corrupt run-evidence leaf", async () => {
    const { runId } = await stageHealthyBundle();
    const paths = operationPaths(root.dir, "research");
    await plantCorruptLeaf(paths.evidenceFile(runId as never, "d".repeat(64)));
    await expectFailClosed("evidence-state");
  });

  it("flags a corrupt orphan run record with no manifest", async () => {
    await stageHealthyBundle();
    const paths = operationPaths(root.dir, "research");
    const orphanRun = path.join(paths.runsRoot, `${mintOperationRunId()}.json`);
    await plantCorruptLeaf(orphanRun);
    await expectFailClosed("run-state");
  });

  it("flags a corrupt run whose bundle payload coverage is incomplete", async () => {
    const { bundleId, runId } = await stageHealthyBundle();
    const paths = operationPaths(root.dir, "research");
    const claimed = createHash("sha256")
      .update(Buffer.from("healthy source payload")).digest("hex");
    await writeFile(paths.payloadFile(bundleId as never, claimed), Buffer.from("x"));
    await writeFile(paths.runFile(runId as never), Buffer.from("not a run record"));
    await expectFailClosed("run-state");
  });

  it("flags an authentic run record relocated under a different run id", async () => {
    const { runId } = await stageHealthyBundle();
    const paths = operationPaths(root.dir, "research");
    const authentic = await readFile(paths.runFile(runId as never));
    await writeFile(path.join(paths.runsRoot, `${mintOperationRunId()}.json`), authentic);
    await expectFailClosed("run-state");
  });

  it("keeps .tmp recovery aliases recoverable rather than corrupt", async () => {
    const { bundleId } = await stageHealthyBundle();
    const paths = operationPaths(root.dir, "research");
    const alias = `${paths.payloadFile(bundleId as never, "e".repeat(64))}.tmp`;
    await plantCorruptLeaf(alias);
    const inventory = await scanOperationInventory(root.dir);
    expect(inventory.problems).toEqual([]);
    const staged = await stageOperationBundleLocked(
      root.dir, sourceStageRequest(Buffer.from("subsequent staging attempt")));
    expect(staged.manifest.bundleId).not.toBe(bundleId);
  });
});

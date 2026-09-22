/**
 * @file test/operation-cli-recovery-e2e.test.ts
 * @description The D13 recovery proof at subprocess level with the REAL production
 * operations-authority resolver. A source-retain bundle is approved and applied
 * through the real resolver, then a crash is simulated AFTER the authoritative
 * effect lands (leaving the run `applying`). While that run is unsettled the shared
 * recovery gate blocks an unrelated mutation; the built CLI `operation resume`
 * recomputes a matching authority snapshot and settles the run to terminal; the
 * unrelated mutation then proceeds. This is the whole point of the resolver: it
 * makes the operation-bundle engine operational in production.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { runCLI } from "./fixtures/run-cli.js";
import { approveAndApplyOperationBundleLocked } from "../src/operation-bundles/executor.js";
import { acquireMutationLock, RecoveryGateError } from "../src/operation-bundles/lock-gate.js";
import { releaseLock } from "../src/utils/lock.js";
import { createOperationsAuthorityResolver } from "../src/operation-bundles/operations-authority-resolver.js";
import { OPERATION_MUTATION_KINDS } from "../src/operation-bundles/adapter-registry.js";
import { approveRequest, authorityRequestFor, buildRuntime, stageSourceBundle, WORKSPACE, type StagedBundle } from "./operation-bundles/executor-fixtures.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "op-cli-e2e-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/** The real production resolver, closed over the seven host adapter kinds. */
const realResolver = createOperationsAuthorityResolver({ adapterKinds: OPERATION_MUTATION_KINDS });

/** Approve+apply a staged bundle through the real resolver, crashing after the effect lands. */
async function crashAfterEffect(staged: StagedBundle): Promise<void> {
  const fault = { async afterApply() { throw new Error("crash after authoritative effect"); } };
  const runtime = buildRuntime({ authority: realResolver, fault });
  await expect(approveAndApplyOperationBundleLocked(root, approveRequest(staged, runtime)))
    .rejects.toThrow("crash after authoritative effect");
}

/** The CLI-observed run state for a bundle via `operation inspect --json`. */
async function inspectState(staged: StagedBundle): Promise<string> {
  const result = await runCLI(["operation", "inspect", staged.bundleId, "--json"], root);
  return JSON.parse(result.stdout).state;
}

describe("operation recovery end-to-end (real resolver)", () => {
  it("resumes a crash-interrupted run and unblocks an unrelated mutation", async () => {
    const staged = await stageSourceBundle(root);
    await crashAfterEffect(staged);
    expect(await inspectState(staged)).toBe("applying");

    await expect(acquireMutationLock(root, "ordinary")).rejects.toBeInstanceOf(RecoveryGateError);

    const resume = await runCLI(["operation", "resume", staged.bundleId, "--json"], root);
    expect(resume.code, resume.stderr).toBe(0);
    expect(JSON.parse(resume.stdout).state).toMatch(/^succeeded/);

    expect(await acquireMutationLock(root, "ordinary")).toBe(true);
    await releaseLock(root);
  });

  it("recovers a crash-interrupted run despite an unrelated corrupted bundle", async () => {
    const bundleA = await stageSourceBundle(root, Buffer.from("bundle A source\n"));
    const bundleB = await stageSourceBundle(root, Buffer.from("bundle B source\n"));
    await crashAfterEffect(bundleA);
    await writeFile(path.join(root, ".llmwiki", "workspaces", WORKSPACE, "bundles", bundleB.bundleId, "manifest.json"), "corrupt", "utf8");
    const resume = await runCLI(["operation", "resume", bundleA.bundleId, "--json"], root);
    expect(resume.code, resume.stderr).toBe(0);
    expect(JSON.parse(resume.stdout).state).toMatch(/^succeeded/);
  });

  it("keeps a bundle's snapshot digest identical across the applying crash window", async () => {
    const staged = await stageSourceBundle(root);
    const before = await realResolver.computeSnapshot(await authorityRequestFor(root, staged));
    await crashAfterEffect(staged);
    const during = await realResolver.computeSnapshot(await authorityRequestFor(root, staged));
    expect(before.status === "ok" && during.status === "ok").toBe(true);
    if (before.status === "ok" && during.status === "ok") expect(during.digest).toBe(before.digest);
  });
});

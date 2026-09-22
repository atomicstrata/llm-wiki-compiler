/**
 * @file test/preparations/cancellation.test.ts
 * @description The advisory `.cancel` file and cancellation-before-launch (design
 * sections 23.1, 23.2). It proves the lock-free write is create-only, a valid
 * request reads back, a forged/oversize/wrong-run file is `unavailable` (never
 * trusted), and a valid cancellation observed at the pre-launch safe boundary
 * settles the phase `cancelled` with the leg never run and the owner cleared.
 */

import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { preparationPaths } from "../../src/preparations/paths.js";
import {
  preparationCancellationRequested, readPreparationCancel, writePreparationCancelLockFree,
} from "../../src/preparations/cancellation.js";
import { readPreparationRun } from "../../src/preparations/run-store.js";
import { executePhaseAttempt } from "../../src/preparations/attempts/execute.js";
import { attemptRequest, stagePreparation, type StagedPreparation } from "./attempt-fixture.js";

const NONCE = "0".repeat(32);
const cancelInput = (staged: StagedPreparation) => ({
  workspaceId: staged.binding.workspaceId, runId: staged.binding.runId, requester: "operator", at: "2026-07-22T00:00:00.000Z", nonce: NONCE,
});

describe("advisory cancel file", () => {
  let staged: StagedPreparation | undefined;
  afterEach(async () => { await staged?.cleanup(); staged = undefined; });

  it("writes create-only and reads a valid present request back", async () => {
    staged = await stagePreparation();
    expect(await writePreparationCancelLockFree(staged.root, cancelInput(staged))).toBe("created");
    expect(await writePreparationCancelLockFree(staged.root, cancelInput(staged))).toBe("exists");
    const read = await readPreparationCancel(staged.root, staged.binding.workspaceId, staged.binding.runId);
    expect(read.status).toBe("present");
  });

  it("treats an oversize file as unavailable, never trusted", async () => {
    staged = await stagePreparation();
    const file = preparationPaths(staged.root, staged.binding.workspaceId).cancelFile(staged.binding.runId);
    await writeFile(file, "x".repeat(4096), { mode: 0o600 });
    const read = await readPreparationCancel(staged.root, staged.binding.workspaceId, staged.binding.runId);
    expect(read.status).toBe("unavailable");
  });

  it("treats a forged wrong-run request as unavailable", async () => {
    staged = await stagePreparation();
    const file = preparationPaths(staged.root, staged.binding.workspaceId).cancelFile(staged.binding.runId);
    await writeFile(file, JSON.stringify({ schemaVersion: 1, runId: `prr_${"9".repeat(32)}`, requester: "x", at: "2026-07-22T00:00:00.000Z", nonce: NONCE }), { mode: 0o600 });
    expect((await readPreparationCancel(staged.root, staged.binding.workspaceId, staged.binding.runId)).status).toBe("unavailable");
  });

  it("reports no valid cancellation when the file is absent", async () => {
    staged = await stagePreparation();
    expect(await preparationCancellationRequested(staged.root, staged.binding.workspaceId, staged.binding.runId)).toBe(false);
  });
});

describe("cancellation before launch", () => {
  let staged: StagedPreparation | undefined;
  afterEach(async () => { await staged?.cleanup(); staged = undefined; });

  it("settles cancelled without running the leg and clears the owner", async () => {
    staged = await stagePreparation();
    await writePreparationCancelLockFree(staged.root, cancelInput(staged));
    const request = attemptRequest(staged, { leg: async () => { throw new Error("leg must not run after a pre-launch cancellation"); } });
    const outcome = await executePhaseAttempt(request);
    expect(outcome).toMatchObject({ status: "committed", phaseState: "cancelled" });
    const read = await readPreparationRun(staged.root, staged.binding);
    if (read.status !== "ok") throw new Error("run unavailable");
    expect(read.run.phaseSummaries[0]?.state).toBe("cancelled");
    expect(read.run.executionOwner).toBeUndefined();
  });
});

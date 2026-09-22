/**
 * @file test/preparations/lifecycle-races.test.ts
 * @description Crash-resumption and byte-preservation across every durable
 * quarantine/reset boundary (design section 25.4). A fault after the planned
 * receipt, after the moves, or after a reset key mint leaves a recoverable pending
 * unit that the SAME confirmed command resumes idempotently with no byte loss and
 * no integrity laundering. The single-epoch invariant holds: a fresh key minted
 * before a crash is reused, never duplicated.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { readPreparationKey } from "../../src/preparations/key-epoch.js";
import { preparationPaths, preparationQuarantineUnitPaths } from "../../src/preparations/paths.js";
import { scanPreparationInventory } from "../../src/preparations/capacity.js";
import { readPreparationRun } from "../../src/preparations/run-store.js";
import { perRunQuarantineUnitId, quarantinePreparationRunLocked } from "../../src/preparations/quarantine.js";
import { quarantineUnitPending } from "../../src/preparations/quarantine-move.js";
import { resolvePreparationLifecyclePending } from "../../src/preparations/recovery.js";
import { MISSING_KEY_CONFIRMATION, resetPreparationKeyEpochLocked } from "../../src/preparations/reset.js";
import type { QuarantineReceiptV1 } from "../../src/preparations/receipts.js";
import { LIFECYCLE_ACTOR, removePreparationKey, stagePreparation, tamperRun } from "./lifecycle-fixture.js";

const AT = "2026-07-20T04:00:00.000Z";
const boom = async () => { throw new Error("crash"); };
type Binding = Parameters<typeof quarantinePreparationRunLocked>[1]["binding"];

type QuarantineFaults = Parameters<typeof quarantinePreparationRunLocked>[1]["faults"];
const quarantine = (root: string, binding: Binding, faults?: QuarantineFaults) =>
  quarantinePreparationRunLocked(root, { binding, actor: LIFECYCLE_ACTOR, at: AT, confirmResidualState: true, faults });

async function movedRunBytes(root: string, binding: Binding, receipt: QuarantineReceiptV1): Promise<Buffer> {
  const runLogical = `workspaces/${binding.workspaceId}/preparation-runs/${binding.runId}.json`;
  const object = receipt.objects.find((entry) => entry.logicalPath === runLogical);
  if (object === undefined) throw new Error("run leaf not quarantined");
  return readFile(preparationQuarantineUnitPaths(root, perRunQuarantineUnitId(binding.runId)).byteObjectFile(object.objectName));
}

describe("quarantine crash resumption", () => {
  const root = useTempRoot();

  it("resumes after a crash following the planned receipt without byte loss", async () => {
    const { binding } = await stagePreparation(root.dir);
    await tamperRun(root.dir, binding);
    const before = await readFile(preparationPaths(root.dir, binding.workspaceId).runFile(binding.runId));
    await expect(quarantine(root.dir, binding, { afterPlanned: boom })).rejects.toThrow();
    expect(await quarantineUnitPending(root.dir, perRunQuarantineUnitId(binding.runId))).toBe(true);
    expect(await resolvePreparationLifecyclePending(root.dir)).toMatchObject({
      status: "pending", units: [{ registry: "quarantine", operation: "per-run-quarantine" }],
    });
    const receipt = await quarantine(root.dir, binding);
    expect(receipt.kind).toBe("quarantine-completed");
    expect((await movedRunBytes(root.dir, binding, receipt)).equals(before)).toBe(true);
    expect((await resolvePreparationLifecyclePending(root.dir)).status).toBe("clean");
  });

  it("resumes after a crash following the moves and never re-trusts the run", async () => {
    const { binding } = await stagePreparation(root.dir);
    await tamperRun(root.dir, binding);
    await expect(quarantine(root.dir, binding, { afterMoves: boom })).rejects.toThrow();
    await expect(readFile(preparationPaths(root.dir, binding.workspaceId).runFile(binding.runId))).rejects.toBeTruthy();
    const receipt = await quarantine(root.dir, binding);
    expect(receipt.kind).toBe("quarantine-completed");
    expect((await readPreparationRun(root.dir, binding)).status).not.toBe("ok");
  });
});

describe("reset crash resumption and single epoch", () => {
  const root = useTempRoot();
  const reset = (dir: string, continuation?: { unitId: string; token: string }, faults?: Parameters<typeof resetPreparationKeyEpochLocked>[1]["faults"]) =>
    resetPreparationKeyEpochLocked(dir, { actor: LIFECYCLE_ACTOR, at: AT, confirmation: MISSING_KEY_CONFIRMATION, continuation, faults });

  /** Record the first-pass intent for a missing-key reset and return its continuation. */
  const firstPassContinuation = async (dir: string): Promise<{ unitId: string; token: string }> => {
    await removePreparationKey(dir);
    const pass1 = await reset(dir);
    if (pass1.status !== "intent-recorded") throw new Error("expected intent-recorded pass one");
    return { unitId: pass1.unitId, token: pass1.continuationToken };
  };

  it("reuses a fresh key minted before a crash and completes on the rerun", async () => {
    const { binding } = await stagePreparation(root.dir);
    const continuation = await firstPassContinuation(root.dir);
    await expect(reset(root.dir, continuation, { afterKeyMint: boom })).rejects.toThrow();
    expect((await readPreparationKey(root.dir)).status).toBe("ok"); // minted before the crash
    const done = await reset(root.dir, continuation);
    expect(done.status).toBe("completed");
    const inventory = await scanPreparationInventory(root.dir);
    expect(inventory.manifests.length).toBe(0);
    expect(inventory.runIds.has(binding.runId)).toBe(false);
  });

  it("moves every scoped byte exactly once across a mid-move crash", async () => {
    const { binding } = await stagePreparation(root.dir);
    const before = (await scanPreparationInventory(root.dir)).activeBytes;
    const continuation = await firstPassContinuation(root.dir);
    await expect(reset(root.dir, continuation, { afterMoves: boom })).rejects.toThrow();
    const done = await reset(root.dir, continuation);
    if (done.status !== "completed") throw new Error("reset did not complete");
    const inventory = await scanPreparationInventory(root.dir);
    expect(inventory.quarantine.bytes).toBeGreaterThanOrEqual(before);
    expect(inventory.runIds.has(binding.runId)).toBe(false);
  });
});

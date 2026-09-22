/**
 * @file test/preparations/quarantine.test.ts
 * @description Per-run quarantine and purge (design sections 25.2, 25.5). An
 * integrity-invalid run under a healthy key is moved byte-for-byte out of active
 * authority, retained until an explicit purge, and every non-qualifying state
 * (valid run, missing key, missing confirmation) fails closed. Quarantine bytes
 * stop counting as active capacity and never launder the invalid run into trust.
 */

import { chmod, link, lstat, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { preparationPaths, preparationQuarantineUnitPaths } from "../../src/preparations/paths.js";
import { scanPreparationInventory } from "../../src/preparations/capacity.js";
import { writePreparationEvidenceCreateOnly } from "../../src/preparations/evidence-store.js";
import {
  perRunQuarantineUnitId, PreparationQuarantineError, purgeQuarantineUnitLocked, quarantinePreparationRunLocked,
} from "../../src/preparations/quarantine.js";
import type { QuarantineReceiptV1 } from "../../src/preparations/receipts.js";
import {
  LIFECYCLE_ACTOR, removePreparationKey, stagePreparation, tamperRun,
} from "./lifecycle-fixture.js";

const AT = "2026-07-20T02:00:00.000Z";
const quarantine = (root: string, binding: Parameters<typeof quarantinePreparationRunLocked>[1]["binding"], confirmResidualState = true) =>
  quarantinePreparationRunLocked(root, { binding, actor: LIFECYCLE_ACTOR, at: AT, confirmResidualState });

/** Stage a preparation, tamper its run into integrity-invalid, and locate the leaf. */
async function tamperedRun(root: string) {
  const { binding } = await stagePreparation(root);
  await tamperRun(root, binding);
  return { binding, runFile: preparationPaths(root, binding.workspaceId).runFile(binding.runId) };
}

/** Crash a quarantine after its plan is durable, then locate one planned object. */
async function plannedObjectAfterCrash(root: string, binding: Parameters<typeof quarantine>[1]) {
  await expect(quarantineWithFaults(root, binding, { afterPlanned: async () => { throw new Error("crash"); } }))
    .rejects.toThrow("crash");
  const paths = preparationQuarantineUnitPaths(root, perRunQuarantineUnitId(binding.runId));
  const plan = JSON.parse(await readFile(paths.plannedReceiptFile, "utf8"));
  const runLogical = `workspaces/${binding.workspaceId}/preparation-runs/${binding.runId}.json`;
  const object = plan.objects.find((entry: { logicalPath: string }) => entry.logicalPath === runLogical);
  return { paths, dest: paths.byteObjectFile(object.objectName) };
}

type Faults = Parameters<typeof quarantinePreparationRunLocked>[1]["faults"];
const quarantineWithFaults = (root: string, binding: Parameters<typeof quarantine>[1], faults: Faults) =>
  quarantinePreparationRunLocked(root, { binding, actor: LIFECYCLE_ACTOR, at: AT, confirmResidualState: true, faults });

async function runObjectPath(root: string, binding: Parameters<typeof quarantine>[1], receipt: QuarantineReceiptV1): Promise<string> {
  const runLogical = `workspaces/${binding.workspaceId}/preparation-runs/${binding.runId}.json`;
  const object = receipt.objects.find((entry) => entry.logicalPath === runLogical);
  if (object === undefined) throw new Error("run leaf not quarantined");
  return preparationQuarantineUnitPaths(root, perRunQuarantineUnitId(binding.runId)).byteObjectFile(object.objectName);
}

describe("per-run quarantine", () => {
  const root = useTempRoot();

  it("moves an integrity-invalid run byte-for-byte and stops counting it as active", async () => {
    const { binding, runFile } = await tamperedRun(root.dir);
    const before = await readFile(runFile);
    const receipt = await quarantine(root.dir, binding);
    expect(receipt.kind).toBe("quarantine-completed");
    const moved = await readFile(await runObjectPath(root.dir, binding, receipt));
    expect(moved.equals(before)).toBe(true);
    const inventory = await scanPreparationInventory(root.dir);
    expect(inventory.quarantine.bytes).toBeGreaterThan(0);
    expect(inventory.runIds.has(binding.runId)).toBe(false);
  });

  it("is idempotent: a re-run resumes the same unit and returns the same objects", async () => {
    const { binding } = await stagePreparation(root.dir);
    await tamperRun(root.dir, binding);
    const first = await quarantine(root.dir, binding);
    const second = await quarantine(root.dir, binding);
    expect(second.objects.map((object) => object.objectName)).toEqual(first.objects.map((object) => object.objectName));
  });

  it("refuses a valid run, a missing confirmation, and a missing key", async () => {
    const { binding } = await stagePreparation(root.dir);
    await expect(quarantine(root.dir, binding)).rejects.toMatchObject({ code: "not-integrity-invalid" });
    await tamperRun(root.dir, binding);
    await expect(quarantine(root.dir, binding, false)).rejects.toBeInstanceOf(PreparationQuarantineError);
    await expect(quarantine(root.dir, binding, false)).rejects.toMatchObject({ code: "confirmation-required" });
    await removePreparationKey(root.dir);
    await expect(quarantine(root.dir, binding)).rejects.toMatchObject({ code: "key-missing" });
  });
});

describe("quarantine purge", () => {
  const root = useTempRoot();
  const purge = (dir: string, unitId: string, confirmDestroy = true) =>
    purgeQuarantineUnitLocked(dir, { unitId, actor: LIFECYCLE_ACTOR, at: AT, confirmDestroy });

  it("destroys only a complete unit's bytes and retains the receipt tombstone", async () => {
    const { binding } = await stagePreparation(root.dir);
    await tamperRun(root.dir, binding);
    await quarantine(root.dir, binding);
    const unitId = perRunQuarantineUnitId(binding.runId);
    await purge(root.dir, unitId);
    const paths = preparationQuarantineUnitPaths(root.dir, unitId);
    await expect(readFile(paths.completedReceiptFile)).resolves.toBeTruthy();
    await expect(readFile(paths.bytesRoot)).rejects.toBeTruthy();
  });

  it("refuses a purge without the destroy confirmation", async () => {
    const { binding } = await stagePreparation(root.dir);
    await tamperRun(root.dir, binding);
    await quarantine(root.dir, binding);
    await expect(purge(root.dir, perRunQuarantineUnitId(binding.runId), false)).rejects.toMatchObject({ code: "confirmation-required" });
  });

  it("refuses to purge an incomplete unit", async () => {
    await stagePreparation(root.dir); // a healthy key must exist to verify a unit
    await expect(purge(root.dir, "qtn-absent")).rejects.toMatchObject({ code: "unit-incomplete" });
  });

  it("refuses a fresh plan whose source changed after the plan became durable", async () => {
    const { binding, runFile } = await tamperedRun(root.dir);
    const drift = async () => { await writeFile(runFile, Buffer.concat([await readFile(runFile), Buffer.from(" ")])); };
    await expect(quarantineWithFaults(root.dir, binding, { afterPlanned: drift })).rejects.toThrow(/changed since the plan/);
    await expect(lstat(runFile)).resolves.toBeTruthy();
  });

  it("refuses to complete when planned bytes sit at the destination beside a live source", async () => {
    const { binding, runFile } = await tamperedRun(root.dir);
    await expect(quarantineWithFaults(root.dir, binding, { afterPlanned: async () => { throw new Error("crash"); } }))
      .rejects.toThrow("crash");
    const paths = preparationQuarantineUnitPaths(root.dir, perRunQuarantineUnitId(binding.runId));
    const plan = JSON.parse(await readFile(paths.plannedReceiptFile, "utf8"));
    const runLogical = `workspaces/${binding.workspaceId}/preparation-runs/${binding.runId}.json`;
    const object = plan.objects.find((entry: { logicalPath: string }) => entry.logicalPath === runLogical);
    await writeFile(paths.byteObjectFile(object.objectName), await readFile(runFile));
    await expect(quarantine(root.dir, binding)).rejects.toThrow(/both present/);
    await expect(lstat(runFile)).resolves.toBeTruthy();
  });

  it("quarantines evidence larger than the old private hash ceiling", async () => {
    const { binding, runFile } = await tamperedRun(root.dir);
    const oversize = Buffer.alloc(4 * 1024 * 1024 + 1, 7);
    await writePreparationEvidenceCreateOnly(root.dir, {
      workspaceId: binding.workspaceId, preparationId: binding.preparationId,
    }, oversize);
    const receipt = await quarantine(root.dir, binding);
    expect(receipt.kind).toBe("quarantine-completed");
    expect(receipt.objects.every((object) => object.digest !== null)).toBe(true);
    await expect(lstat(runFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("completes a commit interrupted after the link but before the source unlink", async () => {
    const { binding, runFile } = await tamperedRun(root.dir);
    const { dest } = await plannedObjectAfterCrash(root.dir, binding);
    // Simulate the exact half-committed state: both names hold the SAME object.
    await link(runFile, dest);
    const receipt = await quarantine(root.dir, binding);
    expect(receipt.kind).toBe("quarantine-completed");
    await expect(lstat(runFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to plan a destructive scope from an incomplete inventory", async () => {
    const { binding, runFile } = await tamperedRun(root.dir);
    const workspaceDir = path.dirname(path.dirname(runFile));
    const blocked = path.join(workspaceDir, "preparations");
    await chmod(blocked, 0o000);
    try {
      await expect(quarantine(root.dir, binding)).rejects.toMatchObject({ code: "unit-unavailable" });
    } finally {
      await chmod(blocked, 0o700);
    }
    await expect(lstat(runFile)).resolves.toBeTruthy();
  });

  it("refuses to purge through a unit symlinked out of the project, deleting nothing", async () => {
    const { binding } = await tamperedRun(root.dir);
    const receipt = await quarantine(root.dir, binding);
    expect(receipt.kind).toBe("quarantine-completed");
    const unitId = perRunQuarantineUnitId(binding.runId);
    const unitRoot = preparationQuarantineUnitPaths(root.dir, unitId).unitRoot;
    const outside = path.join(root.dir, "..", `outside-${unitId}`);
    await rename(unitRoot, outside);
    await symlink(outside, unitRoot);
    try {
      await expect(purge(root.dir, unitId)).rejects.toMatchObject({ code: "unit-unavailable" });
      // The external bytes survive: the refusal happens before any deletion.
      expect((await readdir(path.join(outside, "bytes"))).length).toBeGreaterThan(0);
    } finally {
      await rm(unitRoot, { force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses to purge on a signed planned receipt copied over the completed name", async () => {
    const { binding } = await stagePreparation(root.dir);
    await tamperRun(root.dir, binding);
    await expect(quarantineWithFaults(root.dir, binding, { afterMoves: async () => { throw new Error("crash"); } }))
      .rejects.toThrow("crash");
    const unitId = perRunQuarantineUnitId(binding.runId);
    const paths = preparationQuarantineUnitPaths(root.dir, unitId);
    await writeFile(paths.completedReceiptFile, await readFile(paths.plannedReceiptFile));
    await expect(purge(root.dir, unitId)).rejects.toMatchObject({ code: "unit-unavailable" });
    await expect(lstat(paths.bytesRoot)).resolves.toBeTruthy();
  });
});

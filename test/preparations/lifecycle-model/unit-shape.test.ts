/**
 * @file test/preparations/lifecycle-model/unit-shape.test.ts
 * @description Closes two lifecycle-model dimension values that the historical corpus
 * never exercised directly: a unit directory that exists but is genuinely EMPTY, and a
 * registry entry that is a plain file rather than a directory.
 *
 * These were added because the coverage model demanded them and no existing scenario
 * proved them — citing an unrelated test would have made the matrix decorative. Empty
 * scaffolding must read inert (a crash between `mkdir` and the first durable write is
 * ordinary), while a non-directory entry must read unavailable rather than being
 * skipped, which is the shape that let a real unit be replaced and hidden.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../../fixtures/temp-root.js";
import { PREPARATION_QUARANTINE_SEGMENT } from "../../../src/preparations/paths.js";
import { listQuarantineUnits, quarantineUnitPending } from "../../../src/preparations/quarantine-move.js";
import { scanPreparationInventory } from "../../../src/preparations/capacity.js";
import { perRunQuarantineUnitId, quarantinePreparationRunLocked } from "../../../src/preparations/quarantine.js";
import { LIFECYCLE_ACTOR, stagePreparation, tamperRun } from "../lifecycle-fixture.js";

describe("lifecycle unit shape", () => {
  const root = useTempRoot();

  /** The quarantine registry directory for this project root. */
  const registry = (dir: string) => path.join(dir, ".llmwiki", PREPARATION_QUARANTINE_SEGMENT);

  it("reads an empty unit directory as inert rather than pending", async () => {
    await stagePreparation(root.dir);
    const unitId = "qtn-emptyemptyemptyemptyemptyempt";
    await mkdir(path.join(registry(root.dir), unitId), { recursive: true });
    const listing = await listQuarantineUnits(root.dir);
    expect(listing.status).toBe("ok");
    expect(await quarantineUnitPending(root.dir, unitId)).toBe(false);
  });

  it("accounts for bytes held by an unfinished quarantine rather than losing them", async () => {
    const { binding } = await stagePreparation(root.dir);
    await tamperRun(root.dir, binding);
    const before = await scanPreparationInventory(root.dir);
    await expect(quarantinePreparationRunLocked(root.dir, {
      binding, actor: LIFECYCLE_ACTOR, at: "2026-07-20T02:00:00.000Z", confirmResidualState: true,
      faults: { afterMoves: async () => { throw new Error("crash"); } },
    })).rejects.toThrow("crash");
    // The unit is unfinished, so capacity must still see the bytes somewhere: moved out
    // of active authority and into quarantine, never silently unaccounted.
    expect(await quarantineUnitPending(root.dir, perRunQuarantineUnitId(binding.runId))).toBe(true);
    const after = await scanPreparationInventory(root.dir);
    expect(after.quarantine.bytes).toBeGreaterThan(0);
    expect(after.activeBytes).toBeLessThan(before.activeBytes);
  });

  it("reads a non-directory registry entry as unavailable rather than skipping it", async () => {
    await stagePreparation(root.dir);
    await mkdir(registry(root.dir), { recursive: true });
    await writeFile(path.join(registry(root.dir), "qtn-plainfileplainfileplainfilepf"), "not a unit");
    expect((await listQuarantineUnits(root.dir)).status).toBe("unavailable");
  });
});

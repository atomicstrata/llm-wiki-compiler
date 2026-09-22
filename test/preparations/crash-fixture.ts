/** Real crash-pending lifecycle operations and retained-object witnesses for destructive-gate tests. */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { perRunQuarantineUnitId, quarantinePreparationRunLocked } from "../../src/preparations/quarantine.js";
import { MISSING_KEY_CONFIRMATION, resetPreparationKeyEpochLocked } from "../../src/preparations/reset.js";
import type { PreparationRunBinding } from "../../src/preparations/run-types.js";
import { LIFECYCLE_ACTOR, removePreparationKey, stagePreparation } from "./lifecycle-fixture.js";

/** Crash after authenticated planning for an already-unverifiable run. */
export async function crashQuarantine(root: string, binding: PreparationRunBinding, at: string): Promise<string> {
  await expect(quarantinePreparationRunLocked(root, {
    binding, actor: LIFECYCLE_ACTOR, at, confirmResidualState: true,
    faults: { afterPlanned: async () => { throw new Error("crash"); } },
  })).rejects.toThrow("crash");
  return perRunQuarantineUnitId(binding.runId);
}

/** Leave a real project-key-reset intent awaiting its continuation, asserting the precondition. */
export async function resetAwaitingContinuation(root: string, at: string): Promise<void> {
  await stagePreparation(root);
  await removePreparationKey(root);
  const recorded = await resetPreparationKeyEpochLocked(root, {
    actor: LIFECYCLE_ACTOR, at, confirmation: MISSING_KEY_CONFIRMATION,
  });
  expect(recorded.status).toBe("intent-recorded");
}

/** List every retained workspace leaf using the original root-relative identity convention. */
export async function workspaceFileNames(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(full.slice(root.length));
    }
  };
  await walk(path.join(root, ".llmwiki", "workspaces"));
  return out.sort();
}

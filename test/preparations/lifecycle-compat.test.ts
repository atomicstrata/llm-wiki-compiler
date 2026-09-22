/**
 * @file test/preparations/lifecycle-compat.test.ts
 * @description Production-call regressions and compatibility parity for routing
 * lifecycle readers through one root-bound snapshot.
 */

import { mkdir, rename, symlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { withPreparationLifecycleRead } from "../../src/preparations/lifecycle-snapshot/read.js";
import { quarantinePreparationRunLocked } from "../../src/preparations/quarantine.js";
import { prunePreparationRunLocked } from "../../src/preparations/retention.js";
import { pruneUnitIdFor } from "../../src/preparations/prune-delete.js";
import { gateDecision } from "./lifecycle-fixture.js";
import {
  listQuarantineUnits,
  quarantineUnitPending,
} from "../../src/preparations/quarantine-move.js";
import { resolvePreparationLifecyclePending } from "../../src/preparations/recovery.js";
import { enumeratePreparationReferences } from "../../src/preparations/references.js";
import {
  projectQuarantineUnitPending,
  projectQuarantineUnits,
} from "../../src/preparations/lifecycle-snapshot/compat.js";
import {
  LIFECYCLE_ACTOR,
  driveToFailed,
  stagePreparation,
  tamperRun,
} from "./lifecycle-fixture.js";

/**
 * Capture one snapshot through the public read boundary. The generic root-taking
 * scanner was removed in Chunk 3 precisely so no shared helper could hand a second
 * capture to a caller that already holds a read.
 */
async function capturedSnapshot(root: string) {
  return withPreparationLifecycleRead(root, (read) => {
    if (read.status === "unavailable") throw new Error(read.detail);
    return read.snapshot;
  });
}

describe("preparation lifecycle compatibility", () => {
  const root = useTempRoot();

  it("fails closed when .llmwiki is redirected to an empty in-project decoy", async () => {
    const { binding } = await stagePreparation(root.dir);
    await tamperRun(root.dir, binding);
    await expect(quarantinePreparationRunLocked(root.dir, {
      binding,
      actor: LIFECYCLE_ACTOR,
      at: "2026-07-28T14:00:00.000Z",
      confirmResidualState: true,
      faults: { afterPlanned: async () => { throw new Error("crash"); } },
    })).rejects.toThrow("crash");
    const privateRoot = path.join(root.dir, ".llmwiki");
    await rename(privateRoot, path.join(root.dir, ".llmwiki-authority"));
    const decoy = path.join(root.dir, "decoy");
    await mkdir(path.join(decoy, "preparation-quarantine"), { recursive: true });
    await mkdir(path.join(decoy, "preparation-prune"), { recursive: true });
    await symlink(decoy, privateRoot);
    await expect(resolvePreparationLifecyclePending(root.dir)).resolves
      .toMatchObject({ status: "unavailable" });
    expect((await enumeratePreparationReferences(root.dir)).complete).toBe(false);
  });

  it("projects legacy quarantine reads from exactly one snapshot", async () => {
    const { binding } = await stagePreparation(root.dir);
    await tamperRun(root.dir, binding);
    await expect(quarantinePreparationRunLocked(root.dir, {
      binding,
      actor: LIFECYCLE_ACTOR,
      at: "2026-07-28T14:05:00.000Z",
      confirmResidualState: true,
      faults: { afterPlanned: async () => { throw new Error("crash"); } },
    })).rejects.toThrow("crash");
    const snapshot = await capturedSnapshot(root.dir);
    const listed = await listQuarantineUnits(root.dir);
    expect(listed).toEqual(projectQuarantineUnits(snapshot));
    const unitId = listed.status === "ok" ? listed.unitIds[0] as string : "";
    expect(await quarantineUnitPending(root.dir, unitId))
      .toBe(projectQuarantineUnitPending(snapshot, unitId));
  });

  it("keeps a quarantine resume settled when the later invocation time differs", async () => {
    const { binding } = await stagePreparation(root.dir);
    await tamperRun(root.dir, binding);
    const base = { binding, actor: LIFECYCLE_ACTOR, confirmResidualState: true };
    await expect(quarantinePreparationRunLocked(root.dir, {
      ...base,
      at: "2026-07-28T15:00:00.000Z",
      faults: { afterMoves: async () => { throw new Error("crash"); } },
    })).rejects.toThrow("crash");
    await quarantinePreparationRunLocked(root.dir, {
      ...base,
      at: "2026-07-28T15:01:00.000Z",
    });
    expect((await resolvePreparationLifecyclePending(root.dir)).status).toBe("clean");
  });

  it("keeps a prune resume settled when the later invocation time differs", async () => {
    const { binding } = await stagePreparation(root.dir);
    await driveToFailed(root.dir, binding);
    const base = {
      target: { kind: "run" as const, binding },
      actor: LIFECYCLE_ACTOR,
      clock: { now: () => new Date("2026-09-01T00:00:00.000Z") },
    };
    // EACH CALL NAMES THE DECISION IT ACTS UNDER, and the two differ: the first
    // is a fresh prune of a clean registry, the second is the RESUME of the unit
    // that first call crashed mid-flight. Sharing one authorization across both
    // would have the resume claim a fresh start, which the driver now refuses.
    await expect(prunePreparationRunLocked(root.dir, {
      ...base,
      authorization: gateDecision("prune", pruneUnitIdFor(binding.runId)),
      at: "2026-07-28T15:05:00.000Z",
      faults: { afterDeletes: async () => { throw new Error("crash"); } },
    })).rejects.toThrow("crash");
    await prunePreparationRunLocked(root.dir, {
      ...base,
      authorization: gateDecision(
        "prune", pruneUnitIdFor(binding.runId), pruneUnitIdFor(binding.runId)),
      at: "2026-07-28T15:06:00.000Z",
    });
    expect((await resolvePreparationLifecyclePending(root.dir)).status).toBe("clean");
  });
});

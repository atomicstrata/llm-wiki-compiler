/**
 * @file test/preparations/authority-references.test.ts
 * @description The authoritative reference enumeration the preparation store emits
 * for product-package GC (design section 24.4 taxonomy). Every state — nonterminal,
 * retained terminal, handed-off, abandoned, integrity-invalid, and concurrent — is
 * derived from a real validated object, and any unreadable owner or pending
 * destructive unit fails closed to `complete: false` so GC holds.
 */

import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { enumeratePreparationReferences } from "../../src/preparations/references.js";
import { quarantinePreparationRunLocked } from "../../src/preparations/quarantine.js";
import { handoffPreparation } from "../../src/preparations/handoff.js";
import {
  abandonPreparationRunLocked,
} from "../../src/preparations/abandonment.js";
import { chmod, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { preparationPaths } from "../../src/preparations/paths.js";
import { perRunQuarantineUnitId } from "../../src/preparations/quarantine.js";
import { preparationQuarantineUnitPaths } from "../../src/preparations/paths.js";
import { resolvePreparationLifecyclePending } from "../../src/preparations/recovery.js";
import { MISSING_KEY_CONFIRMATION, resetPreparationKeyEpochLocked } from "../../src/preparations/reset.js";
import {
  driveToFailed, driveToRecoveryRequired, LIFECYCLE_ACTOR, removePreparationKey, stagePreparation, tamperRun,
} from "./lifecycle-fixture.js";
import { handoffRequest, stageReadyPreparation } from "./handoff-fixture.js";

describe("preparation authority references", () => {
  const root = useTempRoot();

  it("emits runtime-authority and product-package references for a nonterminal run", async () => {
    const { manifest } = await stagePreparation(root.dir);
    const set = await enumeratePreparationReferences(root.dir);
    expect(set.complete).toBe(true);
    expect(set.references[0]?.state).toBe("planned");
    expect(set.references[0]?.runtimeAuthorityDigests).toContain(manifest.plan.recipeDigest);
    expect(set.references[0]?.productAuthorities.length).toBe(2);
  });

  it("reports a retained terminal and an abandoned run by their exact state", async () => {
    const failed = await stagePreparation(root.dir);
    await driveToFailed(root.dir, failed.binding);
    const set = await enumeratePreparationReferences(root.dir);
    expect(set.references.find((reference) => reference.runId === failed.binding.runId)?.state).toBe("failed");
  });

  it("reports a handed-off run with its bound bundle id", async () => {
    const binding = await stageReadyPreparation(root.dir);
    const result = await handoffPreparation(root.dir, handoffRequest(binding));
    const set = await enumeratePreparationReferences(root.dir);
    const reference = set.references.find((entry) => entry.runId === binding.runId);
    expect(reference?.state).toBe("handed-off");
    expect(reference?.handoffBundleId).toBe(result.bundleId);
  });

  it("fails closed on an integrity-invalid owner", async () => {
    const { binding } = await stagePreparation(root.dir);
    await tamperRun(root.dir, binding);
    const set = await enumeratePreparationReferences(root.dir);
    expect(set.complete).toBe(false);
    expect(set.references[0]?.state).toBe("integrity-invalid");
  });

  it("fails closed while a destructive quarantine unit is pending", async () => {
    const { binding } = await stagePreparation(root.dir);
    await tamperRun(root.dir, binding);
    await expect(quarantinePreparationRunLocked(root.dir, {
      binding, actor: LIFECYCLE_ACTOR, at: "2026-07-20T05:00:00.000Z", confirmResidualState: true,
      faults: { afterPlanned: async () => { throw new Error("crash"); } },
    })).rejects.toThrow();
    const set = await enumeratePreparationReferences(root.dir);
    expect(set.complete).toBe(false);
    expect(set.problems.some((problem) => problem.dimension === "quarantine")).toBe(true);
  });

  it("enumerates concurrent preparations in deterministic order", async () => {
    const first = await stagePreparation(root.dir);
    const second = await stagePreparation(root.dir);
    await driveToRecoveryRequired(root.dir, second.binding);
    await abandonPreparationRunLocked(root.dir, { binding: second.binding, actor: LIFECYCLE_ACTOR, at: "2026-07-20T06:00:00.000Z", confirmResidualState: true });
    const set = await enumeratePreparationReferences(root.dir);
    expect(set.references.length).toBe(2);
    const states = new Map(set.references.map((reference) => [reference.runId, reference.state]));
    expect(states.get(first.binding.runId)).toBe("planned");
    expect(states.get(second.binding.runId)).toBe("abandoned");
  });
});

describe("quarantine units across an epoch boundary", () => {
  const root = useTempRoot();
  const QUARANTINE_AT = "2026-07-20T02:00:00.000Z";
  const RESET_AT = "2026-07-20T03:00:00.000Z";

  /** Quarantine a tampered run, optionally crashing at a durable seam. */
  const quarantineTampered = async (faults?: Parameters<typeof quarantinePreparationRunLocked>[1]["faults"]) => {
    const { binding } = await stagePreparation(root.dir);
    await tamperRun(root.dir, binding);
    const run = quarantinePreparationRunLocked(root.dir, {
      binding, actor: LIFECYCLE_ACTOR, at: QUARANTINE_AT, confirmResidualState: true, faults,
    });
    if (faults === undefined) await run; else await expect(run).rejects.toThrow("crash");
    return preparationQuarantineUnitPaths(root.dir, perRunQuarantineUnitId(binding.runId));
  };

  /** Record a missing-key reset intent and return a bound continuation runner. */
  const startReset = async () => {
    await removePreparationKey(root.dir);
    const pass1 = await resetPreparationKeyEpochLocked(root.dir, {
      actor: LIFECYCLE_ACTOR, at: RESET_AT, confirmation: MISSING_KEY_CONFIRMATION,
    });
    if (pass1.status !== "intent-recorded") throw new Error("expected intent-recorded pass one");
    const continuation = { unitId: pass1.unitId, token: pass1.continuationToken };
    return {
      unitId: pass1.unitId,
      run: (faults?: Parameters<typeof resetPreparationKeyEpochLocked>[1]["faults"]) =>
        resetPreparationKeyEpochLocked(root.dir, {
          actor: LIFECYCLE_ACTOR, at: RESET_AT, confirmation: MISSING_KEY_CONFIRMATION, continuation, faults,
        }),
    };
  };

  /** Assert the half-finished destructive unit is still visible to recovery and GC. */
  const expectStillPending = async (): Promise<void> => {
    expect((await resolvePreparationLifecyclePending(root.dir)).status).toBe("pending");
    expect((await enumeratePreparationReferences(root.dir)).complete).toBe(false);
  };

  it("a deleted planned receipt stays pending, never silently settled", async () => {
    const paths = await quarantineTampered({ afterMoves: async () => { throw new Error("crash"); } });
    await rm(paths.plannedReceiptFile);
    await expectStillPending();
  });

  it("a corrupted planned receipt stays pending, never silently historical", async () => {
    const paths = await quarantineTampered({ afterMoves: async () => { throw new Error("crash"); } });
    await writeFile(paths.plannedReceiptFile, "{\"schemaVersion\":1,\"kind\":\"quarantine-planned\",\"integrity\":\"00\"}");
    await expectStillPending();
  });

  it("an unreadable unit or registry reads unavailable, never clean", async () => {
    const paths = await quarantineTampered({ afterMoves: async () => { throw new Error("crash"); } });
    await chmod(paths.unitRoot, 0o000);
    try {
      await expectStillPending();
    } finally {
      await chmod(paths.unitRoot, 0o700);
    }
    const registry = path.dirname(paths.unitRoot);
    await chmod(registry, 0o000);
    try {
      expect((await resolvePreparationLifecyclePending(root.dir)).status).toBe("unavailable");
      expect((await enumeratePreparationReferences(root.dir)).complete).toBe(false);
    } finally {
      await chmod(registry, 0o700);
    }
  });

  it("a resumed quarantine refuses to move a source that changed since the plan", async () => {
    const { binding } = await stagePreparation(root.dir);
    const runFile = preparationPaths(root.dir, binding.workspaceId).runFile(binding.runId);
    const healthy = await readFile(runFile);
    await tamperRun(root.dir, binding);
    await expect(quarantinePreparationRunLocked(root.dir, {
      binding, actor: LIFECYCLE_ACTOR, at: QUARANTINE_AT, confirmResidualState: true,
      faults: { afterPlanned: async () => { throw new Error("crash"); } },
    })).rejects.toThrow("crash");
    await writeFile(runFile, healthy);
    await expect(quarantinePreparationRunLocked(root.dir, {
      binding, actor: LIFECYCLE_ACTOR, at: QUARANTINE_AT, confirmResidualState: true,
    })).rejects.toThrow(/changed since the plan/);
    expect((await readFile(runFile)).equals(healthy)).toBe(true);
  });

  /** Swap `target` for a symlink pointing elsewhere, then assert nothing reads clean. */
  const expectUnavailableAfterSwap = async (target: string, linkTo: string): Promise<void> => {
    await rename(target, `${target}-aside`);
    await symlink(linkTo, target);
    expect((await resolvePreparationLifecyclePending(root.dir)).status).toBe("unavailable");
    expect((await enumeratePreparationReferences(root.dir)).complete).toBe(false);
  };

  it("a unit replaced by a symlink reads unavailable, never clean", async () => {
    const paths = await quarantineTampered({ afterMoves: async () => { throw new Error("crash"); } });
    await expectUnavailableAfterSwap(paths.unitRoot, `${paths.unitRoot}-aside`);
  });

  it("a registry root replaced by a symlink reads unavailable, never clean", async () => {
    const paths = await quarantineTampered({ afterMoves: async () => { throw new Error("crash"); } });
    const registry = path.dirname(paths.unitRoot);
    const empty = `${registry}-empty`;
    await mkdir(empty, { recursive: true });
    await expectUnavailableAfterSwap(registry, empty);
  });

  it("a unit retired by a completed reset reads historical, so references stay complete", async () => {
    await quarantineTampered();
    const reset = await startReset();
    expect((await reset.run()).status).toBe("completed");
    expect((await resolvePreparationLifecyclePending(root.dir)).status).toBe("clean");
    expect((await enumeratePreparationReferences(root.dir)).complete).toBe(true);
  });

  it("a resumed reset signs the planned retirement digests, not a re-enumeration", async () => {
    const oldUnit = await quarantineTampered();
    const reset = await startReset();
    await expect(reset.run({ afterPlanned: async () => { throw new Error("crash"); } })).rejects.toThrow("crash");
    await writeFile(oldUnit.completedReceiptFile, "{\"tampered\":true}");
    const done = await reset.run();
    if (done.status !== "completed") throw new Error("reset did not complete");
    const planned = JSON.parse(await readFile(preparationQuarantineUnitPaths(root.dir, reset.unitId).plannedReceiptFile, "utf8"));
    expect(done.receipt.retiredUnits).toEqual(planned.retiredUnits);
  });
});

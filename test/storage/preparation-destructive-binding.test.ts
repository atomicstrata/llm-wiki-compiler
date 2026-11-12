/**
 * @file test/storage/preparation-destructive-binding.test.ts
 * @description The preparation recovery and destructive decisions as root-free
 * bodies over memory steps: the per-run settlement (`settleRunRecoveryWith`), the
 * recovery diagnosis (`recoverLockedWith`), the two-phase quarantine and
 * verified-delete engines (`runTwoPhaseQuarantineWith`, `runTwoPhaseVerifiedDeleteWith`),
 * the quarantine, purge and prune assessments, the project-reset assessment and key
 * materialization (`assessProjectReset`, `materializeResetKeyWith`) and the prune
 * receipt verdict (`verifiedPruneReceipt`).
 *
 * WHAT IS MEMORY ONLY. The doubles log calls and answer scripted states; they prove
 * order, custody (durable transition before advisory removal, and no removal when a
 * settlement did not settle), refusals and receipt binding, not leases, namespaces,
 * inode identity, moves or durable writes. Those stay in the local adapters and
 * are exercised on real fixtures by the existing quarantine/purge, prune/sweep,
 * key-reset, recovery and gate/executor-race suites.
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readPreparationRun } from "../../src/preparations/run-store.js";
import type { PreparationRunV1 } from "../../src/preparations/run-types.js";
import { stagePreparationIn } from "../preparations/attempt-fixture.js";
import { verifiedPruneReceipt } from "../../src/preparations/lifecycle-fs/prune-protocol.js";
import { mintLifecycleMutationPermit } from "../../src/preparations/lifecycle-mutation-permit.js";
import { runTwoPhaseVerifiedDeleteWith, type PruneUnitLeaves } from "../../src/preparations/prune-delete.js";
import { assessPrune, type PruneAssessmentReads } from "../../src/preparations/retention.js";
import { assessProjectReset, materializeResetKeyWith, type ProjectResetSteps } from "../../src/preparations/reset.js";
import { assessPerRunQuarantine, assessQuarantinePurge, PreparationQuarantineError, type QuarantineAssessmentReads } from "../../src/preparations/quarantine.js";
import { runTwoPhaseQuarantineWith, type QuarantineUnitLeaves } from "../../src/preparations/quarantine-move.js";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import { signPruneReceipt } from "../../src/preparations/receipts.js";
import { settleRunRecoveryWith, type PreparationRunSettlementSteps } from "../../src/preparations/recovery.js";
import { recoverLockedWith, type RecoveryDiagnosisSteps } from "../../src/preparations/service-recovery.js";

const KEY = Buffer.alloc(32, 7);
const AT = "2026-07-20T00:00:00.000Z";
const RUN = `prr_${"1".repeat(32)}`;
const BINDING = { runId: RUN, preparationId: `prp_${"2".repeat(32)}`, workspaceId: "research", manifestDigest: `sha256:${"3".repeat(64)}`, keyEpochId: `sha256:${"4".repeat(64)}` } as never;
/** A REAL staged run (genesis transition and all), its state overridden for the memory cases. */
let staged: PreparationRunV1;
let fixtureRoot = "";
beforeAll(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "prep-destructive-binding-"));
  const read = await readPreparationRun(fixtureRoot, (await stagePreparationIn(fixtureRoot)).binding);
  if (read.status !== "ok") throw new Error("fixture run unreadable");
  staged = read.run;
});
afterAll(async () => { if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); });
const run = (state: string, extra: object = {}) => ({ ...staged, state, ...extra }) as never;
const PRINCIPAL = { id: "op", surface: "cli", grants: [] } as never;

/** Memory settlement steps: every call logged; the cancel settlement answers `outcome`. */
function settlement(log: string[], outcome: "settled" | "blocked", requested = true): PreparationRunSettlementSteps {
  const step = (name: string, value: unknown = undefined) => async () => { log.push(name); return value as never; };
  return {
    readBundleManifest: step("readBundleManifest", { status: "absent" }), readOperationKeyEpoch: step("readOperationKeyEpoch", { status: "absent" }),
    readOperationRun: step("readOperationRun", { status: "absent" }), appendTransition: step("appendTransition"), appendHandoff: step("appendHandoff"),
    cancellationRequested: step("cancellationRequested", requested), removeCancel: step("removeCancel"),
    settleCancelledRun: step("settleCancelledRun", outcome === "settled" ? { status: "settled", state: "cancelled" } : { status: "blocked", reason: "x" }),
    carryAdvisoryIntoCancelling: step("carryAdvisoryIntoCancelling"),
  };
}

describe("per-run settlement and recovery diagnosis over memory steps", () => {
  it("D1 removes an advisory only AFTER a settlement that settled; a blocked settlement keeps the honorable request", async () => {
    const settle = async (outcome: "settled" | "blocked", state = "cancelling") => { const log: string[] = []; await settleRunRecoveryWith(settlement(log, outcome), BINDING, run(state), AT); return log; };
    expect(await settle("settled")).toEqual(["settleCancelledRun", "removeCancel"]);
    expect(await settle("blocked")).toEqual(["settleCancelledRun"]);
    expect(await settle("settled", "handoff-ready")).toEqual(["carryAdvisoryIntoCancelling"]);
    expect(await settle("settled", "handoff-started")).toEqual(["appendTransition"]);
    const terminal: string[] = [];
    await settleRunRecoveryWith(settlement(terminal, "settled"), BINDING, run("succeeded"), AT);
    expect(terminal).toEqual(["cancellationRequested", "removeCancel"]);
  });

  it("D2 diagnoses without an ambient probe: a live owner is refused and never parked, a stranded one is parked on its own fencing handles", async () => {
    const owner = { attemptId: "att-1", leaseNonce: "n".repeat(32), pid: 1 };
    const stranded = run("running", { executionOwner: owner, phaseSummaries: [{ currentAttemptId: "att-1", phaseInstanceId: "phi-1" }] });
    const parked: unknown[] = [];
    const steps = (live: boolean): RecoveryDiagnosisSteps => ({
      readLifecyclePending: async () => ({ status: "clean" }), resolveRun: async () => ({ ok: true, run: stranded, binding: BINDING }) as never,
      ownerProcessIsLive: () => live, parkAttempt: async (input) => { parked.push(input); },
    });
    expect(await recoverLockedWith(steps(true), RUN, PRINCIPAL)).toMatchObject({ status: "refused" });
    expect(parked).toEqual([]);
    expect(await recoverLockedWith(steps(false), RUN, PRINCIPAL)).toMatchObject({ status: "parked", runId: RUN });
    expect(parked).toMatchObject([{ attemptId: "att-1", leaseNonce: owner.leaseNonce, phaseInstanceId: "phi-1", binding: BINDING }]);
  });
});

/** Memory unit leaves holding receipts in a map; every call logged. */
function unitLeaves(log: string[], receipts = new Map<string, Buffer>()): QuarantineUnitLeaves {
  return {
    readReceiptLeaf: async (_u, which) => { log.push(`read:${which}`); const body = receipts.get(which); return body === undefined ? { kind: "absent" } : { kind: "ok", body }; },
    prepareBytesRoot: async () => { log.push("prepare"); },
    publishReceipt: async (_u, which, bytes) => { log.push(`publish:${which}`); receipts.set(which, bytes); },
    moveObject: async (_u, object) => { log.push(`move:${object.logicalPath}`); },
    syncBytesRoot: async () => { log.push("sync"); },
    verifyMovedObject: async (_u, object) => { log.push(`verify:${object.logicalPath}`); },
  };
}

describe("the two-phase quarantine engine and the assessments over memory steps", () => {
  const input = (unitId: string) => ({
    permit: mintLifecycleMutationPermit("quarantine", unitId), root: "/never-read", unitId, scope: "per-run" as const, reason: "run-integrity-invalid" as const,
    runId: RUN, key: KEY, keyEpochId: `sha256:${"4".repeat(64)}`, actor: { id: "op", surface: "cli" as const }, at: AT, residualObligations: [],
    objects: [{ sourcePath: "/b", logicalPath: "b", byteCount: 1, digest: null }, { sourcePath: "/a", logicalPath: "a", byteCount: 1, digest: null }],
  });

  it("D3 plans, moves in plan order, syncs, verifies, then completes; a resume reuses the signed plan; a completed unit short-circuits", async () => {
    const fresh: string[] = [], receipts = new Map<string, Buffer>();
    const receipt = await runTwoPhaseQuarantineWith(unitLeaves(fresh, receipts), input("unit-q"));
    expect(fresh).toEqual(["read:completed", "read:planned", "prepare", "publish:planned", "move:a", "move:b", "sync", "verify:a", "verify:b", "publish:completed"]);
    const resumed: string[] = [], planned = new Map([["planned", receipts.get("planned")!]]);
    expect(await runTwoPhaseQuarantineWith(unitLeaves(resumed, planned), input("unit-q"))).toEqual(receipt);
    expect(resumed).toEqual(["read:completed", "read:planned", "move:a", "move:b", "sync", "verify:a", "verify:b", "publish:completed"]);
    const done: string[] = [];
    expect(await runTwoPhaseQuarantineWith(unitLeaves(done, receipts), input("unit-q"))).toEqual(receipt);
    expect(done).toEqual(["read:completed"]);
    await expect(runTwoPhaseQuarantineWith(unitLeaves([], new Map([["completed", receipts.get("planned")!]])), input("unit-q"))).rejects.toThrow("does not bind this unit and kind");
  });

  it("D4 assesses quarantine and purge in the incumbent order with the incumbent refusals", async () => {
    const log: string[] = [];
    const reads = (over: Partial<QuarantineAssessmentReads> = {}): QuarantineAssessmentReads => ({
      readKey: async () => { log.push("readKey"); return { status: "ok", key: KEY, keyEpochId: `sha256:${"4".repeat(64)}` } as never; },
      unitStarted: async () => { log.push("unitStarted"); return false; },
      readSettledReceipt: async () => { log.push("readSettledReceipt"); return null; },
      readRun: async () => { log.push("readRun"); return { status: "ok", run: run("planned") }; },
      enumerateRunScope: async () => { log.push("enumerate"); return []; },
      observePurgeUnit: async () => { log.push("observe"); return { confinement: "confined", receiptStatus: "present" } as never; },
      ...over,
    });
    const capture = { status: "ok", snapshot: { keyState: { status: "ok", keyEpochId: `sha256:${"4".repeat(64)}` } } } as never;
    const quarantine = { authorization: "ungated", binding: BINDING, actor: { id: "op", surface: "cli" }, at: AT, confirmResidualState: true } as never;
    await expect(assessPerRunQuarantine(reads(), quarantine, capture)).rejects.toMatchObject({ code: "not-integrity-invalid" });
    expect(log.splice(0)).toEqual(["readKey", "unitStarted", "readSettledReceipt", "readRun"]);
    await expect(assessQuarantinePurge(reads(), { authorization: "ungated", unitId: "unit-q", actor: { id: "op", surface: "cli" }, at: AT, confirmDestroy: true } as never))
      .rejects.toBeInstanceOf(PreparationQuarantineError);
    expect(log.splice(0)).toEqual(["readKey", "observe", "readSettledReceipt"]);
    await expect(assessQuarantinePurge(reads(), { confirmDestroy: false } as never)).rejects.toMatchObject({ code: "confirmation-required" });
    expect(log).toEqual([]);
  });

  it("D5 decides a prune receipt root-free: absent is null, unreadable and mis-bound throw, the exact signed receipt is returned", () => {
    const content = { schemaVersion: 1 as const, kind: "prune-planned" as const, operation: "prune" as const, unitId: "prn-1", runId: RUN,
      keyEpochId: `sha256:${"4".repeat(64)}`, objects: [], actor: { id: "op", surface: "cli" as const }, at: AT };
    const signed = signPruneReceipt(KEY, content), body = canonicalBytes(signed);
    expect(verifiedPruneReceipt({ kind: "absent" }, KEY, "prune-planned", "prn-1", "prune")).toBeNull();
    expect(() => verifiedPruneReceipt({ kind: "unavailable" }, KEY, "prune-planned", "prn-1", "prune")).toThrow("unreadable");
    expect(() => verifiedPruneReceipt({ kind: "ok", body }, KEY, "prune-planned", "prn-2", "prune")).toThrow("does not bind");
    expect(() => verifiedPruneReceipt({ kind: "ok", body }, Buffer.alloc(32, 8), "prune-planned", "prn-1", "prune")).toThrow("failed verification");
    expect(verifiedPruneReceipt({ kind: "ok", body }, KEY, "prune-planned", "prn-1", "prune")).toEqual(signed);
  });
});

describe("the verified-delete engine, the prune assessment and the reset bodies over memory steps", () => {
  it("D6 confines, plans, deletes in signed-plan index order under the permit, then completes; a resume reuses the signed plan", async () => {
    const receipts = new Map<string, Buffer>(), log: string[] = [];
    const leaves = (entries: string[]): PruneUnitLeaves => ({
      assertConfinedUnit: async () => { entries.push("confine"); },
      readReceiptLeaf: async (_u, kind) => { entries.push(`read:${kind}`); const body = receipts.get(kind); return body === undefined ? { kind: "absent" } : { kind: "ok", body }; },
      publishReceipt: async (permit, _u, kind, bytes) => { entries.push(`publish:${kind}:${permit.operation}`); receipts.set(kind, bytes); },
      deleteObject: async (_p, _u, index, object) => { entries.push(`delete:${index}:${object.logicalPath}`); },
    });
    const input = { permit: mintLifecycleMutationPermit("prune", "prn-1"), root: "/never-read", unitId: "prn-1", operation: "prune" as const, runId: RUN,
      key: KEY, keyEpochId: `sha256:${"4".repeat(64)}`, actor: { id: "op", surface: "cli" as const }, at: AT,
      objects: [{ sourcePath: "/b", logicalPath: "b", byteCount: 1, digest: null }, { sourcePath: "/a", logicalPath: "a", byteCount: 1, digest: null }] };
    const receipt = await runTwoPhaseVerifiedDeleteWith(leaves(log), input);
    expect(log).toEqual(["confine", "read:prune-completed", "read:prune-planned", "publish:prune-planned:prune", "delete:0:a", "delete:1:b", "publish:prune-completed:prune"]);
    receipts.delete("prune-completed");
    const resumed: string[] = [];
    expect(await runTwoPhaseVerifiedDeleteWith(leaves(resumed), input)).toEqual(receipt);
    expect(resumed).toEqual(["confine", "read:prune-completed", "read:prune-planned", "delete:0:a", "delete:1:b", "publish:prune-completed:prune"]);
  });

  it("D7 refuses an unfinished prune with no signed plan before enumerating anything", async () => {
    const log: string[] = [];
    const reads: PruneAssessmentReads = {
      readKey: async () => { log.push("readKey"); return { status: "ok", key: KEY, keyEpochId: `sha256:${"4".repeat(64)}` } as never; },
      readRun: async () => { log.push("readRun"); return { status: "absent" }; },
      readBundleManifest: async () => { log.push("readBundleManifest"); return { status: "absent" }; },
      pruneUnitStarted: async () => { log.push("pruneUnitStarted"); return false; },
      enumerateRunScope: async () => { log.push("enumerateRunScope"); return []; },
      enumerateSweepableOrphans: async () => { log.push("enumerateSweepableOrphans"); return []; },
    };
    await expect(assessPrune(reads, { target: { kind: "unfinished", runId: RUN } } as never, { status: "ok" } as never)).rejects.toMatchObject({ code: "not-eligible", reason: "no-signed-plan-to-resume" });
    expect(log).toEqual(["readKey", "pruneUnitStarted"]);
  });

  it("D8 materializes a forced reset in order (old-key custody, staged-key check, stage, publish) and refuses an unauthenticated staged key before staging", async () => {
    const material = { key: KEY, keyEpochId: `sha256:${"4".repeat(64)}` as never };
    const steps = (pending: string, log: string[]): ProjectResetSteps => ({
      readActiveKey: async () => { log.push("readActiveKey"); return { status: "absent" }; },
      readPendingKey: async () => { log.push("readPendingKey"); return pending === "ok" ? { kind: "ok", material } : { kind: pending } as never; },
      retirableUnits: async () => { log.push("retirableUnits"); return { retired: [], unreadable: [] }; },
      enumerateProjectScope: async () => { log.push("enumerateProjectScope"); return []; },
      moveOldKeyIntoUnit: async () => { log.push("moveOldKey"); },
      stagePendingKey: async () => { log.push("stage"); return material as never; },
      publishActiveKey: async () => { log.push("publish"); },
    });
    const permit = mintLifecycleMutationPermit("reset", "rst-1"), fresh: string[] = [], invalid: string[] = [];
    expect(await materializeResetKeyWith(steps("absent", fresh), "rst-1", "unreadable-key-forced", KEY, {} as never, permit)).toEqual(material);
    expect(fresh).toEqual(["moveOldKey", "readPendingKey", "stage", "publish"]);
    await expect(materializeResetKeyWith(steps("invalid", invalid), "rst-1", "missing-key", KEY, {} as never, permit)).rejects.toMatchObject({ code: "pending-key-invalid" });
    expect(invalid).toEqual(["readPendingKey"]);
    // A healthy active key that is NOT this unit's staged epoch refuses as "key-healthy" BEFORE
    // any retirement or scope read: the assessment reads the key first and stops there.
    const assessed: string[] = [];
    const healthy: ProjectResetSteps = { ...steps("absent", assessed), readActiveKey: async () => { assessed.push("readActiveKey"); return { status: "ok", ...material } as never; } };
    await expect(assessProjectReset(healthy, "rst-1", "missing-key", KEY, { status: "ok" } as never)).rejects.toMatchObject({ code: "key-healthy" });
    expect(assessed).toEqual(["readActiveKey", "readPendingKey"]);
  });
});

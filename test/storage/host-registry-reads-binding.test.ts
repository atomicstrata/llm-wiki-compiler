/**
 * @file test/storage/host-registry-reads-binding.test.ts
 * @description The executable host-handler registry as ONE body over its reads,
 * `createPackHostHandlerRegistryWith` over `PackHostReads`, bound through
 * `packHostReadsOver`, with no project directory. This file uses them, which
 * exist only after the registry was given reads of its own, so it has NO
 * before-edit run.
 *
 * HOW IT IS BUILT. Real compiled actions (the shared runtime fixtures) are
 * executed through the registry over memory reads that log every call. A
 * `phase-output` phase is fed its predecessor's REAL published output (the
 * predecessor executed through the same registry first), so the chained read
 * order (the run, then that evidence object with the source phase's cap) and its
 * refusals are pinned; the `reconcile` family's store snapshot is pinned with its
 * compared class and refusal. The bound composition and the root form are shown
 * reaching each store's body or root reader with exact arguments, the root form
 * reading the root and binding off its dependencies at each read.
 *
 * NOT SHOWN HERE: the six families' content, the snapshot's own ladder and the
 * stores themselves; the host-runtime, store-snapshot and preparation suites show those.
 */

import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import type { CompiledPackActionV1 } from "../../src/operations-packs/compiler-types.js";
import { packHostReadsOver, type PackHostReads } from "../../src/operations-packs/runtime/host-registry-reads.js";
import { createPackHostHandlerRegistry, createPackHostHandlerRegistryWith } from "../../src/operations-packs/runtime/host-registry.js";
import * as storeSnapshot from "../../src/operations-packs/runtime/store-snapshot.js";
import type { HostHandlerInvocationV1, HostHandlerRefV1, HostHandlerResultV1 } from "../../src/preparations/attempts/types.js";
import * as evidenceStore from "../../src/preparations/evidence-store.js";
import { deriveAttemptId, derivePhaseInstanceId, singleExpansionIdentity } from "../../src/preparations/ids.js";
import * as runStore from "../../src/preparations/run-store.js";
import type { PreparationRunBinding } from "../../src/preparations/run-types.js";
import { compileChainedAction, compileReconcilePaperAction } from "../operations-packs/compiled-actions-fixture.js";

afterEach(() => { vi.restoreAllMocks(); });

const MANIFEST = parseSha256Digest(`sha256:${"c".repeat(64)}`);
const RUNTIME = { manifestDigest: MANIFEST, runId: "prr_00000000000000000000000000000001", principal: "pack-runtime", clock: { now: () => "2026-08-14T00:00:00.000Z" } };
const BINDING = { runId: RUNTIME.runId, preparationId: "prp_00000000000000000000000000000001", manifestDigest: MANIFEST, workspaceId: "research" } as unknown as PreparationRunBinding;
const LOCATION = { workspaceId: "research", preparationId: "prp_00000000000000000000000000000001" };

/** The phase instance the registry derives for `logicalPhaseId`. */
const instanceOf = (logicalPhaseId: string) => derivePhaseInstanceId({ manifestDigest: MANIFEST, logicalPhaseId, expansionIdentity: singleExpansionIdentity() });

/** The invocation the attempt boundary would build for one logical phase. */
function invocationFor(logicalPhaseId: string): HostHandlerInvocationV1 {
  const phaseInstanceId = instanceOf(logicalPhaseId);
  return { attemptId: deriveAttemptId(phaseInstanceId, 0), phaseInstanceId, leaseNonce: "nonce-1", inputExposureSetDigest: MANIFEST, maximumOutputBytes: 262_144, maximumWallTimeMs: 5_000 };
}

/** The sealed host-handler ref of `logicalPhaseId`. */
function refOf(action: CompiledPackActionV1, logicalPhaseId: string): HostHandlerRefV1 {
  const executor = action.plan.phases.find((phase) => phase.logicalPhaseId === logicalPhaseId)!.executor as unknown as HostHandlerRefV1;
  return { handlerId: executor.handlerId, handlerContractVersion: executor.handlerContractVersion, handlerContractDigest: executor.handlerContractDigest };
}

/** Execute one phase through the registry's body over `reads`. */
function execute(action: CompiledPackActionV1, logicalPhaseId: string, reads: PackHostReads): Promise<HostHandlerResultV1> {
  return createPackHostHandlerRegistryWith(action, RUNTIME, reads).resolve(refOf(action, logicalPhaseId)).handler.execute(invocationFor(logicalPhaseId));
}

/** Logged memory reads: the run answers `run`, evidence answers `bytes` (or absent), the snapshot answers `snapshot`. */
function readsOf(log: string[], answers: { run?: unknown; bytes?: Buffer; snapshot?: unknown } = {}): PackHostReads {
  return {
    storeSnapshot: async (entityType) => { log.push(`snapshot ${entityType}`); return (answers.snapshot ?? { kind: "refused", detail: "unset" }) as never; },
    readRun: async () => { log.push("run"); return (answers.run ?? { status: "absent" }) as never; },
    evidenceBytes: async (digest, max) => { log.push(`evidence ${digest} ${max}`); return (answers.bytes ? { status: "ok", bytes: answers.bytes } : { status: "absent" }) as never; },
  };
}

/** The chained action's first phase-output consumer, its source phase, and the source's real published output. */
async function chained() {
  const action = await compileChainedAction();
  const consumer = action.plan.phases.find((phase) => phase.inputBindings.some((binding) => binding.sourceKind === "phase-output"))!;
  const source = consumer.inputBindings.find((binding) => binding.sourceKind === "phase-output")!.sourcePhaseId!;
  const sourcePhase = action.plan.phases.find((phase) => phase.logicalPhaseId === source)!;
  const produced = await execute(action, source, readsOf([]));
  if (produced.kind !== "completed") throw new Error(`source phase did not complete: ${JSON.stringify(produced)}`);
  const output = produced.outputs[0]!;
  const ran = { status: "ok", run: { phaseSummaries: [{ phaseInstanceId: instanceOf(source), outputEvidenceDigest: output.digest }] } };
  return { action, consumer: consumer.logicalPhaseId, bytes: await readFile(output.sourcePath), digest: output.digest.replace(/^sha256:/, ""), cap: sourcePhase.bounds.maximumOutputEvidenceBytes, ran };
}

describe("the registry body's predecessor read over memory", () => {
  it("H1 reads the run, then the source phase's committed output under the source's cap, and computes over it", async () => {
    const { action, consumer, bytes, digest, cap, ran } = await chained();
    const log: string[] = [];
    expect((await execute(action, consumer, readsOf(log, { run: ran, bytes }))).kind).toBe("completed");
    expect(log).toEqual(["run", `evidence ${digest} ${cap}`]);
  });

  it("H2 refuses an unreadable run, a source with no committed output, and absent evidence, each after its own read", async () => {
    const { action, consumer, digest, cap, ran } = await chained();
    const outcome = async (answers: Parameters<typeof readsOf>[1]) => {
      const log: string[] = [];
      const result = await execute(action, consumer, readsOf(log, answers));
      return [result.kind === "failed" ? result.problem : result.kind, log];
    };
    const problem = "pack-phase-output-input-deferred";
    expect(await outcome({ run: { status: "unavailable" } })).toEqual([problem, ["run"]]);
    expect(await outcome({ run: { status: "ok", run: { phaseSummaries: [] } } })).toEqual([problem, ["run"]]);
    expect(await outcome({ run: ran })).toEqual([problem, ["run", `evidence ${digest} ${cap}`]]);
  });

  it("H3 the reconcile family reads the snapshot of its compared class, and an unavailable snapshot refuses the phase", async () => {
    const compiled = await compileReconcilePaperAction({ topic: "superconductivity", doi: "10.1/abc" });
    const binding = compiled.phaseBindings.find((entry) => entry.family === "reconcile")!;
    // The phase's own input is the frozen action input alone here, so the only read is the snapshot.
    const phases = compiled.plan.phases.map((phase) => (phase.logicalPhaseId === binding.logicalPhaseId ? { ...phase, inputBindings: [] } : phase));
    const action = { ...compiled, plan: { ...compiled.plan, phases } } as CompiledPackActionV1;
    const log: string[] = [];
    const result = await execute(action, binding.logicalPhaseId, readsOf(log, { snapshot: { kind: "refused", detail: "the project profile is unreadable" } }));
    expect([result.kind === "failed" && result.problem, log]).toEqual(["pack-store-snapshot-unavailable", [`snapshot ${(binding.body as { comparedEvidenceClass: string }).comparedEvidenceClass}`]]);
  });
});

describe("the bound composition and the root form", () => {
  it("B1 the composition reaches each store's own body over its seam, at the binding's location", async () => {
    const seams = { snapshot: { tag: "snapshot" }, runs: { tag: "runs" }, evidence: { tag: "evidence" } } as never as Record<string, never>;
    const snapshot = vi.spyOn(storeSnapshot, "packStoreSnapshotFrom").mockResolvedValue({ kind: "refused", detail: "x" });
    const run = vi.spyOn(runStore, "readPreparationRunFrom").mockResolvedValue({ status: "absent" } as never);
    const bytes = vi.spyOn(evidenceStore, "readPreparationEvidenceBytesFrom").mockResolvedValue({ status: "absent" } as never);
    const reads = packHostReadsOver({ snapshot: seams.snapshot, runs: seams.runs, evidence: seams.evidence }, BINDING);
    await Promise.all([reads.storeSnapshot("papers"), reads.readRun(), reads.evidenceBytes("ab", 9)]);
    expect([snapshot.mock.calls, run.mock.calls, bytes.mock.calls]).toEqual([[[seams.snapshot, "papers"]], [[seams.runs, BINDING]], [[seams.evidence, LOCATION, "ab", 9]]]);
  });

  it("B2 the root form reads the root and binding off its dependencies at each read, with the old arguments", async () => {
    const { action, consumer, bytes, digest, cap, ran } = await chained();
    const run = vi.spyOn(runStore, "readPreparationRun").mockResolvedValue(ran as never);
    const evidence = vi.spyOn(evidenceStore, "readPreparationEvidenceBytes").mockResolvedValue({ status: "ok", bytes } as never);
    const deps = { ...RUNTIME, root: "/built-with", binding: BINDING };
    const registry = createPackHostHandlerRegistry(action, deps);
    deps.root = "/read-at-execution";
    expect((await registry.resolve(refOf(action, consumer)).handler.execute(invocationFor(consumer))).kind).toBe("completed");
    expect([run.mock.calls, evidence.mock.calls]).toEqual([[["/read-at-execution", BINDING]], [["/read-at-execution", LOCATION, digest, cap]]]);
  });
});

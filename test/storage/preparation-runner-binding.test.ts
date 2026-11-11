/**
 * @file test/storage/preparation-runner-binding.test.ts
 * @description The host runner as ONE body over steps that take no project
 * root: `runPreparationWith` over `RunnerSteps`. This file uses it, which exists
 * only after the runner was given its steps, so it has NO before-edit run.
 *
 * HOW IT IS BUILT. Memory steps answer over the runner-managed fixture plan and a
 * held run that each committed attempt and fan-out settles into, logging every
 * call, so the state classification, the drive order up to an undecided gate,
 * the busy retry, each refusal, and the reconstruct-and-handoff leg with its
 * error mapping are pinned in order. The composition is shown reaching each
 * bound body over its own seam, and the root form the incumbents with its root.
 *
 * NOT SHOWN HERE: the attempt, fan-out, gate, finalization, read-back and handoff
 * bodies themselves; each has its own binding suite.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as execute from "../../src/preparations/attempts/execute.js";
import * as fanOut from "../../src/preparations/fan-out-driver.js";
import * as finalization from "../../src/preparations/finalization.js";
import * as gateDriver from "../../src/preparations/gate-driver.js";
import * as handoff from "../../src/preparations/handoff.js";
import { MATERIALIZATION_MANIFEST_KIND } from "../../src/preparations/materialization.js";
import * as manifestStore from "../../src/preparations/manifest-store.js";
import * as runStore from "../../src/preparations/run-store.js";
import * as reconstruct from "../../src/preparations/runner-reconstruct.js";
import { runPreparation, runPreparationWith, type RunPreparationInputV1 } from "../../src/preparations/runner.js";
import { runnerStepsOver, type RunnerSteps } from "../../src/preparations/runner-steps.js";
import { declareMaterializationCapacity } from "../preparations/materialization-fixture.js";
import { fixturePlan } from "../preparations/store-fixture.js";

afterEach(() => { vi.restoreAllMocks(); });

const PIN = `sha256:${"c".repeat(64)}` as never;
const BINDING = { workspaceId: "ws", preparationId: "prep_1", runId: "prr_1", manifestDigest: `sha256:${"9".repeat(64)}` } as never;
const PLAN = fixturePlan((plan) => declareMaterializationCapacity(plan));
const MANIFEST = { status: "ok", manifest: { plan: PLAN } };

/** A runner input without a root, over the fixture's pinned contract. */
function inputOf(overrides: Partial<RunPreparationInputV1> = {}): Omit<RunPreparationInputV1, "root"> {
  return {
    binding: BINDING, materializer: { handlerContractDigest: PIN, materialize: () => { throw new Error("unreached"); } },
    legFor: () => async () => { throw new Error("unreached"); }, authorityResolver: { resolve: async () => ({ status: "unavailable", reason: "x" }) as never },
    adapters: new Map(), policyContract: { exclusionReasonCodes: [], reconciliationReasonCodes: [], proposalKinds: [] } as never,
    principal: { id: "operator", surface: "cli" }, operationPrincipal: { id: "operator", surface: "cli", grants: [] } as never,
    handlerContractDigest: PIN, clock: { now: () => "2026-10-14T00:00:00.000Z" }, ...overrides,
  };
}

/** What the memory steps answer. */
interface World { state?: string; manifest?: unknown; busy?: number; evidenceRefs?: unknown[]; handoffFault?: Error }

/** Memory steps over a held run that attempts and fan-outs settle into; every call logged. */
function stepsOf(log: string[], world: World = {}): RunnerSteps {
  const run = { state: world.state ?? "running", phaseSummaries: [] as unknown[], evidenceRefs: world.evidenceRefs ?? [], transitions: [{ contentHash: "tip" }], stateVersion: 1, gateProofs: [] };
  let busy = world.busy ?? 0;
  const settle = (logicalPhaseId: string) => { run.phaseSummaries.push({ phaseInstanceId: `phi_${logicalPhaseId}`, logicalPhaseId, state: "succeeded" }); };
  return {
    readRun: async () => { log.push("run"); return { status: "ok", run } as never; },
    readManifest: async () => { log.push("manifest"); return (world.manifest ?? MANIFEST) as never; },
    evidenceBytes: async (digest) => { log.push(`evidence ${digest}`); return { status: "absent" }; },
    readManifestBack: async (digest) => { log.push(`manifest-back ${digest}`); return { body: { payloadRefs: [], operationRun: {} } } as never; },
    readPayloadsBack: async () => { log.push("payloads-back"); return new Map(); },
    driveMap: async (_input, phase) => { log.push(`map ${phase.logicalPhaseId}`); settle(phase.logicalPhaseId); return null; },
    driveRepeat: async (_input, phase) => { log.push(`repeat ${phase.logicalPhaseId}`); return null; },
    blockAtGate: async (gate) => { log.push(`block ${gate.gateId}`); return { status: "moved", run } as never; },
    resumeFromGate: async (gate) => { log.push(`resume ${gate.gateId}`); return { status: "moved", run } as never; },
    executeAttempt: async (request) => {
      log.push(`attempt ${request.logicalPhaseId}`);
      if (busy-- > 0) return { status: "refused-busy" };
      settle(request.logicalPhaseId);
      return { status: "committed", attemptId: "a" as never, phaseState: "succeeded" };
    },
    finalize: async () => { log.push("finalize"); return { status: "finalized" } as never; },
    appendTransition: async () => { log.push("append"); return run as never; },
    handoff: async () => { log.push("handoff"); if (world.handoffFault) throw world.handoffFault; return { outcome: "handed-off", bundleManifestDigest: "bundle" } as never; },
  };
}

/** Run over `world` and `input`: the result and the log. */
async function runOver(world: World = {}, input = inputOf()): Promise<[unknown, string[]]> {
  const log: string[] = [];
  return [await runPreparationWith(stepsOf(log, world), input), log];
}

const MANIFEST_REF = { kind: MATERIALIZATION_MANIFEST_KIND, digest: "sha256:ab" };

describe("the runner's body over its steps", () => {
  it("N1 drives each ready phase in order until an undecided gate, then suspends there", async () => {
    expect(await runOver()).toEqual([{ status: "suspended-at-gate", runId: "prr_1" },
      ["run", "manifest", "manifest", "run", "run", "attempt collect", "run", "map expand", "run", "run", "block review"]]);
  });

  it("N2 retries one busy attempt, and reports refused-busy after the retry is spent", async () => {
    expect((await runOver({ busy: 1 }))[1].filter((call) => call.startsWith("attempt"))).toEqual(["attempt collect", "attempt collect"]);
    expect(await runOver({ busy: 2 })).toEqual([{ status: "refused-busy", runId: "prr_1" }, ["run", "manifest", "manifest", "run", "run", "attempt collect", "attempt collect"]]);
  });

  it("N3 classifies terminal states with one read, and refuses missing limits, a missing materializer or a mismatched contract before driving", async () => {
    expect(await runOver({ state: "cancelled" })).toEqual([{ status: "cancelled", runId: "prr_1" }, ["run"]]);
    const noLimits = { status: "ok", manifest: { plan: fixturePlan() } };
    expect(await runOver({ manifest: noLimits })).toEqual([{ status: "refused", runId: "prr_1", reason: "plan does not declare the materialization limits" }, ["run", "manifest"]]);
    expect((await runOver({}, inputOf({ materializer: undefined })))[0]).toMatchObject({ reason: "a running plan requires a materializer" });
    expect((await runOver({}, inputOf({ handlerContractDigest: `sha256:${"d".repeat(64)}` as never })))[0]).toMatchObject({ reason: "materializer contract does not match the plan pin" });
  });

  it("N4 reconstructs a handoff-ready run from its one manifest and hands off; a handoff error is a refusal", async () => {
    const ready = { state: "handoff-ready", evidenceRefs: [MANIFEST_REF] };
    expect(await runOver(ready)).toEqual([{ status: "handed-off", runId: "prr_1", bundleManifestDigest: "bundle" },
      ["run", "manifest", "run", "manifest-back sha256:ab", "payloads-back", "handoff"]]);
    const fault = new handoff.HandoffError("x" as never, "stale");
    expect((await runOver({ ...ready, handoffFault: fault }))[0]).toEqual({ status: "refused", runId: "prr_1", reason: `handoff: ${fault.message}` });
    expect((await runOver({ state: "handoff-ready" }))[0]).toEqual({ status: "refused", runId: "prr_1", reason: "materialization manifests: none" });
  });
});

describe("the composition and the root form", () => {
  it("B1 the composition reaches each bound body over its own seam, at the binding", async () => {
    const seams = { runs: { tag: "runs" }, manifests: { tag: "manifests" }, evidence: { tag: "evidence" }, writes: { tag: "writes" },
      gate: { tag: "gate" }, finalization: { tag: "finalization" }, handoff: { tag: "handoff" } } as never as Record<string, never>;
    const attemptSteps = { tag: "attempt" } as never;
    const spies = [
      vi.spyOn(runStore, "readPreparationRunFrom"), vi.spyOn(manifestStore, "readPreparationManifestFrom"),
      vi.spyOn(gateDriver, "blockAtGateWith"), vi.spyOn(execute, "executePhaseAttemptWith"), vi.spyOn(finalization, "finalizePreparationForHandoffWith"),
      vi.spyOn(runStore, "appendPreparationTransitionWith"), vi.spyOn(handoff, "handoffPreparationWith"),
    ].map((spy) => spy.mockResolvedValue({} as never));
    const fan = vi.spyOn(fanOut, "driveMapPhaseWith").mockResolvedValue(null);
    const back = vi.spyOn(reconstruct, "readManifestBackFrom").mockResolvedValue("x");
    const steps = runnerStepsOver({ ...seams, attempt: () => attemptSteps } as never, BINDING);
    await Promise.all([steps.readRun(), steps.readManifest(), steps.blockAtGate({} as never, {} as never, "t"), steps.executeAttempt({} as never),
      steps.finalize({} as never), steps.appendTransition({} as never, {} as never), steps.handoff({} as never),
      steps.driveMap({} as never, {} as never, {} as never, async () => null), steps.readManifestBack("d", 1)]);
    expect(spies.map((spy) => spy.mock.calls[0]?.[0])).toEqual([seams.runs, seams.manifests, seams.gate, attemptSteps, seams.finalization, seams.writes, seams.handoff]);
    expect([fan.mock.calls[0]?.[0], typeof back.mock.calls[0]?.[0]]).toEqual([expect.objectContaining({ readRun: expect.any(Function) }), "function"]);
  });

  it("B2 the root form reads with its root and the binding, as before", async () => {
    const read = vi.spyOn(runStore, "readPreparationRun").mockResolvedValue({ status: "ok", run: { state: "running" } } as never);
    const manifest = vi.spyOn(manifestStore, "readPreparationManifest").mockResolvedValue({ status: "absent" });
    expect(await runPreparation({ root: "/project", ...inputOf() } as RunPreparationInputV1)).toMatchObject({ status: "refused" });
    expect([read.mock.calls, manifest.mock.calls]).toEqual([[["/project", BINDING]], [["/project", "ws", "prep_1"]]]);
  });
});

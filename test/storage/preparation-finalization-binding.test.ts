/**
 * @file test/storage/preparation-finalization-binding.test.ts
 * @description Finalization and the attempt's cancellation delivery as ONE body
 * each over steps that take no project root: `finalizePreparationForHandoffWith`
 * over `FinalizationSteps`, and `runAttemptLegWith` over a cancellation probe.
 * This file uses them, which exist only after each was given its steps, so it
 * has NO before-edit run.
 *
 * HOW IT IS BUILT. Memory steps log every call, so the precondition ladder, the
 * lock's acquire/release pairing, the evidence writes and the projected append
 * are pinned in order, over the runner-managed fixture plan and the fixture
 * materialization result. The compositions are shown reaching each lower body
 * over its own seam, and the root forms every incumbent with exact arguments.
 *
 * NOT SHOWN HERE: the live-lease refusal, the evidence store, the append's own
 * fences, and the in-flight poll and cancel deadline; the finalization, evidence,
 * run-store and cancel-delivery suites show those.
 */

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { runAttemptLeg, runAttemptLegWith } from "../../src/preparations/attempts/cancel-delivery.js";
import * as cancellation from "../../src/preparations/cancellation.js";
import * as evidenceStore from "../../src/preparations/evidence-store.js";
import {
  finalizationStepsOver, finalizePreparationForHandoff, finalizePreparationForHandoffWith,
  type FinalizationBodyInputV1, type FinalizationSteps,
} from "../../src/preparations/finalization.js";
import * as manifestStore from "../../src/preparations/manifest-store.js";
import { captureMaterializationResult } from "../../src/preparations/materialization.js";
import * as runStore from "../../src/preparations/run-store.js";
import { FIXTURE_PAYLOAD, FIXTURE_PAYLOAD_DIGEST, declareMaterializationCapacity, materializedResultCandidate } from "../preparations/materialization-fixture.js";
import { fixturePlan } from "../preparations/store-fixture.js";
import { orderedStubs } from "./call-log.js";
import { spyBlockingLockedRunRead } from "./preparation-lock-spies.js";

afterEach(() => { vi.restoreAllMocks(); });

const BINDING = { workspaceId: "ws", preparationId: "prep_1", runId: "run_1" } as never;
const LOCATION = { workspaceId: "ws", preparationId: "prep_1" };
const MANIFEST = { status: "ok", manifest: { plan: fixturePlan((plan) => declareMaterializationCapacity(plan)) } };
/** A run in `state` with one settled phase, and the one transition its predecessor is read from. */
const runIn = (state: string, phaseSummaries: unknown[] = [{ phaseInstanceId: "phi_1", state: "succeeded", disposition: "required" }]) =>
  ({ runId: "run_1", state, stateVersion: 4, transitions: [{ contentHash: "tip" }], phaseSummaries, evidenceRefs: [], completionWarnings: [] }) as never;

/** The body input over the fixture result and payload. */
const bodyInput = (payloads = new Map([[FIXTURE_PAYLOAD_DIGEST, FIXTURE_PAYLOAD]])): FinalizationBodyInputV1 => ({
  binding: BINDING, result: captureMaterializationResult(materializedResultCandidate()),
  operationPrincipal: { id: "operator", surface: "cli", grants: ["operation-bundle.approve"] },
  handlerContractDigest: `sha256:${"c".repeat(64)}` as never, payloads, principal: { id: "operator", surface: "cli" }, at: "2026-10-14T00:00:00.000Z",
});

/** What the memory steps answer. */
interface World { read?: unknown; cancelled?: boolean; manifest?: unknown }

/** Memory finalization steps over `world`, each call logged (written bytes shortened to their digest's first 8 characters). */
function stepsOf(log: string[], world: World = {}): FinalizationSteps {
  const run = world.read ?? { status: "ok", run: runIn("running") };
  return {
    lock: { acquire: async () => { log.push("acquire"); }, release: async () => { log.push("release"); } },
    readRun: async () => { log.push("read"); return run as never; },
    cancellationRequested: async (workspaceId, runId) => { log.push(`cancel ${workspaceId}/${runId}`); return world.cancelled ?? false; },
    readManifest: async (workspaceId, preparationId) => { log.push(`manifest ${workspaceId}/${preparationId}`); return (world.manifest ?? MANIFEST) as never; },
    writeEvidence: async (location, bytes) => { log.push(`write ${location.preparationId} ${createHash("sha256").update(bytes).digest("hex").slice(0, 8)}`); return "created"; },
    appendProjected: async (_binding, expected, input, project) => {
      log.push(`append ${input.type} @${expected.stateVersion}/${expected.chainTip}`);
      return project((run as { run: never }).run) as never;
    },
  };
}

/** Finalize over `world`: the result (or its refusal reason) and the log. */
async function finalizeOver(world: World = {}, input = bodyInput()): Promise<[unknown, string[]]> {
  const log: string[] = [];
  const result = await finalizePreparationForHandoffWith(stepsOf(log, world), input);
  return [result.status === "finalized" ? result.manifestDigest : result.reason, log];
}

const PRE = ["acquire", "read", "cancel ws/run_1", "manifest ws/prep_1"];

describe("finalization over its steps", () => {
  it("F1 checks the run, the cancel and the plan, writes each payload then the manifest, appends handoff-ready, then releases", async () => {
    const [digest, log] = await finalizeOver();
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(log).toEqual([...PRE, `write prep_1 ${FIXTURE_PAYLOAD_DIGEST.slice(0, 8)}`, `write prep_1 ${(digest as string).slice(0, 8)}`, "append handoff-ready @4/tip", "release"]);
  });

  it("F2 every precondition refuses after its own read, writes nothing, and releases", async () => {
    const released = (count: number) => [...PRE.slice(0, count), "release"];
    expect(await finalizeOver({ read: { status: "absent" } })).toEqual(["run unreadable: absent", released(2)]);
    expect(await finalizeOver({ read: { status: "ok", run: runIn("paused") } })).toEqual(["run state is paused, not running", released(2)]);
    expect(await finalizeOver({ cancelled: true })).toEqual(["a cancellation is pending", released(3)]);
    expect(await finalizeOver({ read: { status: "ok", run: runIn("running", []) } })).toEqual(["no phase has settled", released(3)]);
    expect(await finalizeOver({ manifest: { status: "absent" } })).toEqual(["preparation manifest unreadable: absent", released(4)]);
    expect(await finalizeOver({}, bodyInput(new Map()))).toEqual([`payload ${FIXTURE_PAYLOAD_DIGEST} is not supplied`, released(4)]);
  });

  it("F3 the body captures its input before the first await: a caller retargeting its binding afterwards moves nothing", async () => {
    const log: string[] = [];
    const input = bodyInput();
    const pending = finalizePreparationForHandoffWith(stepsOf(log), input);
    Object.assign(input, { binding: { workspaceId: "other", preparationId: "other", runId: "other" } });
    await pending;
    expect(log.slice(2, 4)).toEqual(["cancel ws/run_1", "manifest ws/prep_1"]);
  });
});

describe("the attempt leg's cancellation delivery over its probe", () => {
  const OUTCOME = { phaseState: "succeeded" } as never;
  const deliver = async (requested: boolean) => {
    const asked: string[] = [], ran: string[] = [];
    const request = { binding: BINDING, leg: async () => { ran.push("leg"); return OUTCOME; } } as never;
    const delivery = await runAttemptLegWith(async (workspaceId, runId) => { asked.push(`${workspaceId}/${runId}`); return requested; }, request, { attemptId: "a" } as never);
    return { delivery, asked, ran };
  };

  it("L1 a cancel present at the boundary short-circuits before the leg; otherwise the leg's outcome is delivered unobserved", async () => {
    const cancelled = await deliver(true);
    expect([cancelled.delivery.cancellationObserved, cancelled.delivery.outcome.phaseState, cancelled.asked, cancelled.ran]).toEqual([true, "cancelled", ["ws/run_1"], []]);
    const ran = await deliver(false);
    expect([ran.delivery, ran.asked.slice(0, 1), ran.ran]).toEqual([{ outcome: OUTCOME, cancellationObserved: false }, ["ws/run_1"], ["leg"]]);
  });
});

describe("the compositions and the root forms", () => {
  it("B1 the composition reaches each store's own body over its own seam, and carries the caller's lock as given", async () => {
    const seams = { runs: { tag: "runs" }, advisories: { tag: "advisories" }, manifests: { tag: "manifests" }, evidence: { tag: "evidence" }, writes: { tag: "writes" } } as never as Record<string, never>;
    const spies = [
      vi.spyOn(runStore, "readPreparationRunFrom"), vi.spyOn(cancellation, "preparationCancellationRequestedFrom"),
      vi.spyOn(manifestStore, "readPreparationManifestFrom"), vi.spyOn(evidenceStore, "writePreparationEvidenceCreateOnlyWith"),
      vi.spyOn(runStore, "appendPreparationTransitionWith"),
    ].map((spy) => spy.mockResolvedValue({} as never));
    const callerLock = { acquire: async () => {}, release: async () => {} };
    const steps = finalizationStepsOver({ runs: seams.runs, advisories: seams.advisories, manifests: seams.manifests, evidence: seams.evidence, writes: seams.writes }, callerLock);
    const project: runStore.PreparationRunContentProjector = (content) => content;
    await Promise.all([steps.readRun(BINDING), steps.cancellationRequested("ws", "run_1" as never), steps.readManifest("ws", "prep_1" as never),
      steps.writeEvidence(LOCATION as never, FIXTURE_PAYLOAD), steps.appendProjected(BINDING, {} as never, { type: "x" } as never, project)]);
    expect([...spies.map((spy) => spy.mock.calls), steps.lock]).toEqual([
      [[seams.runs, BINDING]], [[seams.advisories, "ws", "run_1"]], [[seams.manifests, "ws", "prep_1"]],
      [[seams.evidence, LOCATION, FIXTURE_PAYLOAD]], [[seams.writes, BINDING, {}, { type: "x" }, project]], callerLock,
    ]);
  });

  it("B2 the finalization root form reaches every incumbent with the captured root, in order", async () => {
    const stubs = orderedStubs();
    const { order, note } = stubs;
    const { acquire, read, release } = spyBlockingLockedRunRead(stubs, runIn("running"));
    const cancel = vi.spyOn(cancellation, "preparationCancellationRequested").mockImplementation(note("cancel", false));
    const manifest = vi.spyOn(manifestStore, "readPreparationManifest").mockImplementation(note("manifest", MANIFEST as never));
    const write = vi.spyOn(evidenceStore, "writePreparationEvidenceCreateOnly").mockImplementation(note("write", "created" as const));
    const append = vi.spyOn(runStore, "appendProjectedTransitionLocked").mockImplementation(async (_r, _b, _e, _i, project) => { order.push("append"); return project(runIn("running")) as never; });
    expect((await finalizePreparationForHandoff({ root: "/project", ...bodyInput() })).status).toBe("finalized");
    expect(order).toEqual(["acquire", "read", "cancel", "manifest", "write", "write", "append", "release"]);
    expect([acquire.mock.calls, read.mock.calls, cancel.mock.calls, manifest.mock.calls, release.mock.calls]).toEqual([
      [["/project", "ordinary"]], [["/project", BINDING, expect.anything()]], [["/project", "ws", "run_1"]], [["/project", "ws", "prep_1"]], [["/project"]],
    ]);
    expect([write.mock.calls[0]?.slice(0, 2), append.mock.calls[0]?.slice(0, 3)]).toEqual([["/project", LOCATION], ["/project", BINDING, { stateVersion: 4, chainTip: "tip" }]]);
  });

  it("B3 the attempt leg's root form polls the incumbent with the request's root", async () => {
    const polled = vi.spyOn(cancellation, "preparationCancellationRequested").mockResolvedValue(true);
    const delivery = await runAttemptLeg({ root: "/project", binding: BINDING, leg: async () => ({}) } as never, { attemptId: "a" } as never);
    expect([delivery.cancellationObserved, polled.mock.calls]).toEqual([true, [["/project", "ws", "run_1"]]]);
  });
});

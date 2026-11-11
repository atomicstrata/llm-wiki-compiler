/**
 * @file test/storage/product-service-binding.test.ts
 * @description The product service's verbs as ONE body over their steps,
 * `createProductServiceWith`, with no project directory. This file uses it, which
 * exists only after the service was given steps of its own, so it has NO
 * before-edit run.
 *
 * HOW IT IS BUILT. Memory steps answer the resolution, the preparation service,
 * the run lookups, the sealed input, the parent verdict, the admission lock and
 * the drive, and log every call. So each verb's sequence (preview; invoke's
 * stage, locate and drive; resume's recovery, digest guard, parent admission
 * under the lock and re-drive), every refusal and what each must not do are
 * pinned, and the constructor's pins are shown fixed against later edits. The
 * bound composition is shown reaching each read's own body over its seam with
 * the host's capabilities as given, and the root form every incumbent root form
 * with exact arguments.
 *
 * NOT SHOWN HERE: resolution, staging, the runner and the parent store
 * themselves; the product, preparation and workflow-parent suites show those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as actionResolve from "../../src/products/action-resolve.js";
import * as evidenceStore from "../../src/preparations/evidence-store.js";
import * as lockGate from "../../src/operation-bundles/lock-gate.js";
import * as runner from "../../src/preparations/runner.js";
import * as runnerInput from "../../src/operations-packs/runtime/runner-input.js";
import * as runLookup from "../../src/preparations/service-run-lookup.js";
import * as workflowParent from "../../src/preparations/workflow-parent.js";
import * as lock from "../../src/utils/lock.js";
import { createProductService, createProductServiceWith, productServiceStepsOver, type ProductServiceSteps } from "../../src/products/service.js";
import { REQUEST_CAPTURE_REFUSAL } from "../../src/preparations/service-request-capture.js";

afterEach(() => { vi.restoreAllMocks(); });

const COMPILED = { actionId: "demo.run", recipeId: "demo.prepare", planDigest: "sha256:plan", planDocument: "{}", initialInput: { value: { topic: "t" } }, plan: { phases: [{ gate: { gateId: "g1" } }] } };
const RESOLVED = { status: "resolved", action: { compiled: COMPILED, route: "alias", requestedSurface: "sdk", binding: {} } };
const SUMMARY = { actionId: "demo.run", recipeId: "demo.prepare", planDigest: "sha256:plan", requestedSurface: "sdk", route: "alias" };
const PARENT = { workflowRunId: "build-1", workflowId: "build", stageId: "draft" };
const MANIFEST = { workspaceId: "ws", preparationId: "prep_1", planDigest: "sha256:plan", plan: { initialInputSet: { digest: "sha256:seal", byteCount: 12 } } };
const BINDING = { runId: "prun-1" };
const PINS = { surface: "sdk", adapters: new Map(), clock: { now: () => "2026-01-01T00:00:00.000Z" } } as never;

/** What the steps answer; anything left out answers as a healthy run does. */
interface World { resolved?: unknown; sealed?: unknown; manifest?: unknown; parent?: unknown; verdict?: unknown; driven?: unknown }

/** Memory steps over `world`, each call logged. */
function stepsOf(log: string[], world: World = {}): ProductServiceSteps {
  const record = (line: string) => { log.push(line); };
  return {
    resolveAction: async (request) => { record(`resolve ${request.token} ${JSON.stringify(request.input)}${request.workflowParent ? " parent" : ""}`); return (world.resolved ?? RESOLVED) as never; },
    preparations: {
      preview: async () => { record("preview"); return { status: "previewed", workspaceId: "ws" } as never; },
      stage: async () => { record("stage"); return { status: "staged", runId: "prun-1" } as never; },
    },
    locateManifest: async (runId) => { record(`manifest ${runId}`); return (world.manifest ?? { ok: true, manifest: { ...MANIFEST, plan: { ...MANIFEST.plan, ...(world.parent ? { workflowParent: world.parent } : {}) } } }) as never; },
    readSealedInput: async (location, digest, max) => { record(`sealed ${location.workspaceId}/${location.preparationId} ${digest} ${max}`); return (world.sealed ?? { status: "ok", bytes: Buffer.from('{"topic":"t"}') }) as never; },
    acquireAdmissionLock: async () => { record("lock"); },
    releaseAdmissionLock: async () => { record("release"); },
    verifyParent: async (parent) => { record(`parent ${parent.workflowRunId}`); return (world.verdict ?? { status: "verified", workflowId: "build", runStatus: "running", currentStage: "draft" }) as never; },
    locateRun: async (runId) => { record(`run ${runId}`); return { ok: true, binding: BINDING } as never; },
    drive: async (_compiled, context) => { record(`drive ${context.surface} ${context.binding === (BINDING as never)}`); return (world.driven ?? { status: "handed-off", runId: "prun-1", bundleManifestDigest: "sha256:bundle" }) as never; },
  };
}

const REQUEST = { workspaceId: "ws", token: "draft", input: { topic: "t" } };
const RESUME = { workspaceId: "ws", runId: "prun-1", token: "draft" };

describe("the product service's one body over memory steps", () => {
  it("V1 previews by resolving then previewing; invokes by resolving, staging, locating the run and driving it", async () => {
    const log: string[] = [];
    const service = createProductServiceWith(stepsOf(log), PINS);
    expect(await service.preview(REQUEST)).toEqual({ status: "previewed", action: SUMMARY, workspaceId: "ws" });
    expect(await service.invoke(REQUEST)).toEqual({ status: "handed-off", action: SUMMARY, runId: "prun-1", bundleManifestDigest: "sha256:bundle" });
    expect(log).toEqual(['resolve draft {"topic":"t"}', "preview", 'resolve draft {"topic":"t"}', "stage", "run prun-1", "drive sdk true"]);
  });

  it("V2 refuses an accessor request or input before any step, and a refused resolution before staging", async () => {
    const log: string[] = [];
    const service = createProductServiceWith(stepsOf(log, { resolved: { status: "refused", reason: "no product" } }), PINS);
    const accessor = Object.defineProperty({ workspaceId: "ws", input: {} }, "token", { get: () => "draft", enumerable: true });
    expect(await service.invoke(accessor as never)).toEqual({ status: "refused", reason: REQUEST_CAPTURE_REFUSAL });
    expect(await service.invoke({ ...REQUEST, input: Object.defineProperty({}, "topic", { get: () => "t", enumerable: true }) } as never)).toEqual({ status: "refused", reason: REQUEST_CAPTURE_REFUSAL });
    expect([await service.invoke(REQUEST), log]).toEqual([{ status: "refused", reason: "no product" }, ['resolve draft {"topic":"t"}']]);
  });

  it("V3 resumes from the run's own sealed input, guards the plan digest, and re-drives without a parent lock when unparented", async () => {
    const log: string[] = [];
    expect(await createProductServiceWith(stepsOf(log), PINS).resume(RESUME)).toMatchObject({ status: "handed-off", runId: "prun-1" });
    expect(log).toEqual(["manifest prun-1", "sealed ws/prep_1 seal 12", 'resolve draft {"topic":"t"}', "run prun-1", "drive sdk true"]);
    const drifted = { status: "resolved", action: { ...RESOLVED.action, compiled: { ...COMPILED, planDigest: "sha256:other" } } };
    const guardLog: string[] = [];
    expect(await createProductServiceWith(stepsOf(guardLog, { resolved: drifted }), PINS).resume(RESUME))
      .toEqual({ status: "refused", reason: "that action does not reproduce this run's sealed plan" });
    expect(guardLog.at(-1)).toMatch(/^resolve /);
  });

  it("V4 refuses an unlocated run and an unreadable sealed input before resolving; undecodable sealed bytes reject, as the incumbent's do", async () => {
    const refusal = async (world: World) => {
      const log: string[] = [];
      const result = await createProductServiceWith(stepsOf(log, world), PINS).resume(RESUME);
      return [(result as { reason: string }).reason, log.length];
    };
    expect(await refusal({ manifest: { ok: false, reason: "no such run" } })).toEqual(["no such run", 1]);
    expect(await refusal({ sealed: { status: "absent" } })).toEqual(["the run's sealed input is absent", 2]);
    // `capturedOr` maps only a capture refusal; a JSON syntax fault is not one, so it propagates (unchanged behaviour).
    await expect(createProductServiceWith(stepsOf([], { sealed: { status: "ok", bytes: Buffer.from("{") } }), PINS).resume(RESUME)).rejects.toBeInstanceOf(SyntaxError);
  });

  it("V5 admits a parented resume only under the lock, releasing it before the drive or on refusal", async () => {
    const log: string[] = [];
    await createProductServiceWith(stepsOf(log, { parent: PARENT }), PINS).resume(RESUME);
    expect(log.slice(2)).toEqual(['resolve draft {"topic":"t"} parent', "lock", "parent build-1", "release", "run prun-1", "drive sdk true"]);
    const stopped = { status: "verified", workflowId: "build", runStatus: "completed", currentStage: null };
    const refusedLog: string[] = [];
    expect(await createProductServiceWith(stepsOf(refusedLog, { parent: PARENT, verdict: stopped }), PINS).resume(RESUME))
      .toEqual({ status: "refused", reason: "workflow-parent-not-running" });
    expect(refusedLog.slice(-3)).toEqual(["lock", "parent build-1", "release"]);
  });

  it("V6 the pins are read once at construction: editing the pins object afterwards changes nothing", async () => {
    const log: string[] = [];
    const pins = { surface: "sdk", adapters: new Map(), clock: { now: () => "x" } };
    const service = createProductServiceWith(stepsOf(log), pins as never);
    pins.surface = "mcp";
    await service.invoke(REQUEST);
    expect(log.at(-1)).toBe("drive sdk true");
  });
});

describe("the bound composition and the root form", () => {
  it("B1 the composition reaches the resolver's, lookup's, evidence store's and parent store's own bodies, and keeps the host's lock, preparations and drive", async () => {
    const seams = { action: { tag: "action" }, lookup: { tag: "lookup" }, evidence: { tag: "evidence" }, parents: { tag: "parents" } } as never as Record<string, never>;
    const memory = stepsOf([]);
    const located = vi.spyOn(runLookup, "locatePreparationManifestFrom").mockResolvedValue({ ok: true, manifest: { ...MANIFEST, plan: { ...MANIFEST.plan, workflowParent: PARENT } } } as never);
    const sealed = vi.spyOn(evidenceStore, "readPreparationEvidenceBytesFrom").mockResolvedValue({ status: "ok", bytes: Buffer.from('{"topic":"t"}') } as never);
    const resolved = vi.spyOn(actionResolve, "resolveProductActionWith").mockResolvedValue(RESOLVED as never);
    const verified = vi.spyOn(workflowParent, "verifyWorkflowParentFrom").mockResolvedValue({ status: "verified", workflowId: "build", runStatus: "running", currentStage: "draft" } as never);
    const run = vi.spyOn(runLookup, "resolvePreparationRunFrom").mockResolvedValue({ ok: true, binding: BINDING } as never);
    const log: string[] = [];
    const host = { ...stepsOf(log), preparations: memory.preparations };
    const steps = productServiceStepsOver({ action: seams.action, lookup: seams.lookup, evidence: seams.evidence, parents: seams.parents, host });
    expect(await createProductServiceWith(steps, PINS).resume(RESUME)).toMatchObject({ status: "handed-off" });
    expect([located.mock.calls, sealed.mock.calls[0]?.[0], resolved.mock.calls[0]?.[0], verified.mock.calls, run.mock.calls]).toEqual([
      [[seams.lookup, "prun-1"]], seams.evidence, seams.action, [[seams.parents, PARENT]], [[seams.lookup, "prun-1"]],
    ]);
    expect([steps.preparations, log]).toEqual([memory.preparations, ["lock", "release", "drive sdk true"]]);
  });


  it("R1 the root form: a parented resume reaches every incumbent root form with the constructor's root and the old arguments", async () => {
    const located = vi.spyOn(runLookup, "locatePreparationManifest").mockResolvedValue({ ok: true, manifest: { ...MANIFEST, plan: { ...MANIFEST.plan, workflowParent: PARENT } } } as never);
    const sealed = vi.spyOn(evidenceStore, "readPreparationEvidenceBytes").mockResolvedValue({ status: "ok", bytes: Buffer.from('{"topic":"t"}') } as never);
    const resolved = vi.spyOn(actionResolve, "resolveProductAction").mockResolvedValue(RESOLVED as never);
    const acquire = vi.spyOn(lockGate, "acquireMutationLockBlocking").mockResolvedValue(undefined);
    const release = vi.spyOn(lock, "releaseLock").mockResolvedValue(undefined);
    const verified = vi.spyOn(workflowParent, "verifyWorkflowParent").mockResolvedValue({ status: "verified", workflowId: "build", runStatus: "running", currentStage: "draft" } as never);
    const run = vi.spyOn(runLookup, "resolvePreparationRun").mockResolvedValue({ ok: true, binding: BINDING } as never);
    const assembled = vi.spyOn(runnerInput, "assembleRunnerInput").mockReturnValue({} as never);
    vi.spyOn(runner, "runPreparation").mockResolvedValue({ status: "handed-off", runId: "prun-1", bundleManifestDigest: "sha256:bundle" } as never);
    const service = createProductService({ root: "/project", surface: "sdk", principals: { principalFor: () => null } as never, adapters: new Map(), clock: { now: () => "x" } });
    expect(await service.resume(RESUME)).toMatchObject({ status: "handed-off" });
    expect([located.mock.calls, sealed.mock.calls[0], resolved.mock.calls[0]?.[0]]).toEqual([[["/project", "prun-1"]], ["/project", { workspaceId: "ws", preparationId: "prep_1" }, "seal", 12], "/project"]);
    expect([acquire.mock.calls, verified.mock.calls, release.mock.calls, run.mock.calls]).toEqual([[["/project", "ordinary"]], [["/project", PARENT]], [["/project"]], [["/project", "prun-1"]]]);
    expect(Object.keys(assembled.mock.calls[0]![1])).toEqual(["root", "binding", "adapters", "clock", "surface"]);
    expect(assembled.mock.calls[0]![1].root).toBe("/project");
  });
});

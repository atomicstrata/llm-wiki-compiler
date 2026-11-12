/**
 * @file test/storage/preparation-handoff-operation-binding.test.ts
 * @description The `handoff` service operation as ONE body over its project
 * steps, `handoffPreparationOperationWith` over `HandoffOperationSteps`, with no
 * project. This file uses the body, which exists only after the operation was
 * given its steps, so it has NO before-edit run.
 *
 * HOW IT IS BUILT. Memory steps answer readiness, the run lookup, the substrate
 * flow and the clock, and log each call, so every refusal is pinned with the
 * steps it reached: the request capture, the incomplete obligation set, an
 * unready project, an unresolved run, a run not yet startable, and the
 * substrate's typed refusal against a fault it must not convert. The capture is
 * shown fixing the request before the first await. The composition is shown
 * reaching the readiness, lookup and substrate bodies over their seams, and the
 * root form the incumbents with its root.
 *
 * NOT SHOWN HERE: the substrate flow, the readiness and lookup reads themselves,
 * and the obligation capture's leaf rules; the handoff, service-handoff and
 * obligation-capture suites show those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as handoff from "../../src/preparations/handoff.js";
import * as readiness from "../../src/preparations/service-readiness.js";
import * as runLookup from "../../src/preparations/service-run-lookup.js";
import {
  handoffOperationStepsOver, handoffPreparationOperation, handoffPreparationOperationWith, type HandoffOperationSteps, type HandoffRequestV1,
} from "../../src/preparations/service-handoff.js";
import { REQUEST_CAPTURE_REFUSAL } from "../../src/preparations/service-request-capture.js";

afterEach(() => { vi.restoreAllMocks(); });

const PRINCIPAL = { id: "host-1", surface: "sdk", grants: ["preparation.run"] } as never;
const AT = "2026-10-14T00:00:00.000Z";
const BINDING = { runId: "prr_bound" } as never;
const SETTLED = { outcome: "handed-off", handoffId: "h", bundleId: "b", operationRunId: "o", bundleManifestDigest: "d" } as never;

/** A request whose obligations pass the capture: a compilation with its adapter map, empty authorities, evidence and payloads. */
function request(runId = "prr_1"): HandoffRequestV1 {
  return { runId, obligations: { compilation: { adapters: new Map() }, authorities: { grant: "g" }, preparationEvidence: [], payloads: new Map() } } as never;
}

/** What the memory steps answer. */
interface HandoffWorld { ready?: string | null; run?: { state: string } | { reason: string }; settle?: Error }

/** Memory operation steps; each call logged, the substrate's request kept. */
function stepsOf(log: string[], world: HandoffWorld = {}, seen: unknown[] = []): HandoffOperationSteps {
  return {
    now: () => { log.push("now"); return AT; },
    readiness: async () => { log.push("readiness"); return world.ready === undefined ? { ready: true, reason: null } : { ready: false, reason: world.ready }; },
    resolveRun: async (runId) => {
      log.push(`run ${runId}`);
      const run = world.run ?? { state: "handoff-ready" };
      return ("reason" in run ? { ok: false, failure: "unavailable", reason: run.reason } : { ok: true, binding: BINDING, run }) as never;
    },
    handoff: async (input) => { log.push("handoff"); seen.push(input); if (world.settle) throw world.settle; return SETTLED; },
  };
}

/** Run the body over fresh memory steps: the result and the log. */
async function over(req: unknown, world: HandoffWorld = {}) {
  const log: string[] = [];
  return [await handoffPreparationOperationWith(stepsOf(log, world), PRINCIPAL, req as HandoffRequestV1), log];
}

describe("the handoff operation over its project steps", () => {
  it("H1 refuses an uncapturable request with no step, and an incomplete obligation set after only the clock", async () => {
    const getter = Object.defineProperty({}, "runId", { get: () => "prr_1", enumerable: true });
    expect(await over(getter)).toEqual([{ status: "refused", reason: REQUEST_CAPTURE_REFUSAL }, []]);
    expect(await over({ runId: "prr_1" })).toEqual([{ status: "refused", reason: "the handoff obligation set is incomplete" }, ["now"]]);
  });

  it("H2 refuses an unready project, an unresolved run and a run not yet startable, each before the substrate", async () => {
    expect(await over(request(), { ready: "key unreadable" })).toEqual([{ status: "refused", reason: "key unreadable" }, ["now", "readiness"]]);
    expect((await over(request(), { ready: null }))[0]).toEqual({ status: "refused", reason: "the project is not ready" });
    expect(await over(request(), { run: { reason: "no such run" } })).toEqual([{ status: "refused", reason: "no such run" }, ["now", "readiness", "run prr_1"]]);
    expect(await over(request(), { run: { state: "running" } })).toEqual([
      { status: "refused", reason: "only a settled run can be handed off; this run is running" }, ["now", "readiness", "run prr_1"],
    ]);
  });

  it("H3 hands a startable run to the substrate with its binding, actor, clock and captured obligations", async () => {
    const log: string[] = [];
    const seen: Array<Record<string, unknown>> = [];
    const result = await handoffPreparationOperationWith(stepsOf(log, { run: { state: "handoff-started" } }, seen), PRINCIPAL, request());
    expect(result).toEqual({ status: "handed-off", runId: "prr_1", handoffId: "h", bundleId: "b", operationRunId: "o", bundleManifestDigest: "d" });
    expect(log).toEqual(["now", "readiness", "run prr_1", "handoff"]);
    expect([seen[0]!.binding, seen[0]!.actor, seen[0]!.at, seen[0]!.authorities, "supersedesBundleId" in seen[0]!]).toEqual([
      BINDING, { id: "host-1", surface: "sdk" }, AT, { grant: "g" }, false,
    ]);
  });

  it("H4 maps the substrate's typed refusal to a refusal and lets any other fault throw", async () => {
    const refusal = new handoff.HandoffError("run-not-settled" as never, "not settled");
    expect((await over(request(), { settle: refusal }))[0]).toEqual({ status: "refused", reason: refusal.message });
    await expect(over(request(), { settle: new Error("EIO") })).rejects.toThrow("EIO");
  });

  it("H5 fixes the request before the first await: a caller's later edits reach no step", async () => {
    const log: string[] = [];
    const seen: Array<Record<string, unknown>> = [];
    const req = request() as unknown as { runId: string; obligations: { authorities: { grant: string } } };
    const pending = handoffPreparationOperationWith(stepsOf(log, {}, seen), PRINCIPAL, req as never);
    req.runId = "prr_other";
    req.obligations.authorities.grant = "changed";
    await pending;
    expect([log[2], seen[0]!.authorities]).toEqual(["run prr_1", { grant: "g" }]);
  });
});

describe("the composition and the root form", () => {
  it("B1 the composition reaches the readiness, lookup and substrate bodies over their seams", async () => {
    const seams = { readiness: { tag: "readiness" }, runs: { tag: "runs" }, handoff: { tag: "handoff" } } as never as Record<string, never>;
    const ready = vi.spyOn(readiness, "resolveHostReadinessFrom").mockResolvedValue({ ready: true, reason: null });
    const run = vi.spyOn(runLookup, "resolvePreparationRunFrom").mockResolvedValue({ ok: true, binding: BINDING, run: { state: "handoff-ready" } } as never);
    const settle = vi.spyOn(handoff, "handoffPreparationWith").mockResolvedValue(SETTLED);
    await handoffPreparationOperationWith(handoffOperationStepsOver(seams as never, () => AT), PRINCIPAL, request());
    expect([ready.mock.calls, run.mock.calls, settle.mock.calls[0]?.[0], (settle.mock.calls[0]?.[1] as { at: string }).at]).toEqual([
      [[seams.readiness]], [[seams.runs, "prr_1"]], seams.handoff, AT,
    ]);
  });

  it("B2 the root form reaches the incumbent readiness, lookup and substrate with its root", async () => {
    const ready = vi.spyOn(readiness, "resolveHostReadiness").mockResolvedValue({ ready: true, reason: null });
    const run = vi.spyOn(runLookup, "resolvePreparationRun").mockResolvedValue({ ok: true, binding: BINDING, run: { state: "handoff-ready" } } as never);
    const settle = vi.spyOn(handoff, "handoffPreparation").mockResolvedValue(SETTLED);
    expect((await handoffPreparationOperation("/project", PRINCIPAL, request())).status).toBe("handed-off");
    expect([ready.mock.calls, run.mock.calls, settle.mock.calls[0]?.[0]]).toEqual([[["/project"]], [["/project", "prr_1"]], "/project"]);
  });
});

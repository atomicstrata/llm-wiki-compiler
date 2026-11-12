/**
 * @file test/storage/preparation-control-verbs-binding.test.ts
 * @description The operator control verbs as ONE body each over steps that
 * take no project root: the shared target resolution and locked append
 * (`withControlTargetFrom`, `appendControlTransitionWith`), `fail`, `pause` and
 * `resume` over `ControlVerbSteps`, and `cancel` over `CancelSteps`. This file
 * uses them, which exist only after each verb was given its steps, so it has NO
 * before-edit run.
 *
 * HOW IT IS BUILT. Memory steps log every call, so each refusal, the order of
 * reads, the lock's acquire/release pairing and the transition each verb
 * appends are pinned. The compositions are shown reaching each lower body over
 * its own seam, and the root forms reaching every incumbent root reader, the
 * lock and the writer with exact arguments.
 *
 * NOT SHOWN HERE: readiness, lookup, authentication, the append's own fences
 * and the advisory leaf; the service, run-store and cancellation suites show
 * those, and the request-capture suites show the capture totality.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as lockGate from "../../src/operation-bundles/lock-gate.js";
import * as cancellation from "../../src/preparations/cancellation.js";
import * as runStore from "../../src/preparations/run-store.js";
import { cancelPreparationOperation, cancelPreparationOperationWith, cancelStepsOver, type CancelSteps } from "../../src/preparations/service-cancel.js";
import {
  appendControlTransitionWith, controlVerbStepsOver, withControlTargetFrom, type ControlVerbSteps,
} from "../../src/preparations/service-control-transition.js";
import { failPreparationOperation, failPreparationOperationWith } from "../../src/preparations/service-fail.js";
import { pausePreparationOperationWith } from "../../src/preparations/service-pause.js";
import * as readiness from "../../src/preparations/service-readiness.js";
import { resumePreparationOperationWith } from "../../src/preparations/service-resume.js";
import * as lookup from "../../src/preparations/service-run-lookup.js";
import * as lock from "../../src/utils/lock.js";
import { orderedStubs } from "./call-log.js";

afterEach(() => { vi.restoreAllMocks(); });

const PRINCIPAL = { id: "operator", surface: "sdk", grants: [] } as never;
/** The run every case names: an id the preparation identity grammar admits, since the cancel path validates it. */
const BINDING = { workspaceId: "ws", runId: "prr_11111111111111111111111111111111" } as never;
/** A run in `state`, with the one transition its predecessor is read from. */
const runIn = (state: string, extra: object = {}) => ({ state, stateVersion: 3, transitions: [{ contentHash: "tip", payload: { kind: "none" } }], ...extra }) as never;

/** What the memory steps answer. */
interface World { ready?: boolean; run?: unknown; acquire?: boolean | Error; append?: Error }

/** Memory control steps over `world`, each call logged. */
function controlSteps(log: string[], world: World = {}): ControlVerbSteps {
  return {
    hostReadiness: async () => { log.push("ready"); return world.ready === false ? { ready: false, reason: "no key" } : { ready: true, reason: null }; },
    resolveRun: async (runId) => { log.push(`run ${runId}`); return (world.run ?? { ok: true, binding: BINDING, run: runIn("planned") }) as never; },
    lock: {
      acquire: async () => { log.push("acquire"); if (world.acquire instanceof Error) throw world.acquire; return world.acquire ?? true; },
      release: async () => { log.push("release"); },
    },
    appendTransition: async (_binding, expected, transition) => {
      log.push(`append ${transition.type}->${transition.stateAfter} @${expected.stateVersion}/${expected.chainTip}`);
      if (world.append) throw world.append;
    },
  };
}

describe("the shared target resolution and locked append", () => {
  it("C1 refuses an unready project before the lookup, and a lookup refusal before the verb's own policy", async () => {
    const run = async (world: World) => {
      const log: string[] = [];
      return [await withControlTargetFrom(controlSteps(log, world), "prr_11111111111111111111111111111111", async () => "applied"), log];
    };
    expect(await run({ ready: false })).toEqual([{ status: "refused", reason: "no key" }, ["ready"]]);
    expect(await run({ run: { ok: false, reason: "no such run" } })).toEqual([{ status: "refused", reason: "no such run" }, ["ready", "run prr_11111111111111111111111111111111"]]);
    expect(await run({})).toEqual(["applied", ["ready", "run prr_11111111111111111111111111111111"]]);
  });

  it("C2 returns a busy lock and the gate's refusal without releasing, rethrows any other fault, and always releases what it took", async () => {
    const transition = { type: "failed", stateAfter: "failed" } as never;
    const append = async (world: World) => {
      const log: string[] = [];
      return [await appendControlTransitionWith(controlSteps(log, world), BINDING, runIn("planned"), transition).catch((error: Error) => error.message), log];
    };
    expect(await append({ acquire: false })).toEqual([{ ok: false, reason: "project lock is busy" }, ["acquire"]]);
    expect(await append({ acquire: new lockGate.RecoveryGateError("x" as never, "reset pending") })).toEqual([{ ok: false, reason: "reset pending" }, ["acquire"]]);
    expect(await append({ acquire: new Error("EIO") })).toEqual(["EIO", ["acquire"]]);
    expect(await append({})).toEqual([{ ok: true }, ["acquire", "append failed->failed @3/tip", "release"]]);
    expect(await append({ append: new Error("fenced") })).toEqual(["fenced", ["acquire", "append failed->failed @3/tip", "release"]]);
  });
});

describe("fail, pause and resume over the shared steps", () => {
  /** One verb over `world`: its answer and the log. */
  const verb = async (op: typeof failPreparationOperationWith | typeof pausePreparationOperationWith | typeof resumePreparationOperationWith, world: World) => {
    const log: string[] = [];
    return [await op(controlSteps(log, world), PRINCIPAL, { runId: "prr_11111111111111111111111111111111" }), log];
  };
  const target = ["ready", "run prr_11111111111111111111111111111111"];
  const of = (state: string, extra?: object) => ({ run: { ok: true, binding: BINDING, run: runIn(state, extra) } });

  it("V1 each verb appends its own transition only from its own state, and refuses or no-ops elsewhere without the lock", async () => {
    expect(await verb(failPreparationOperationWith, of("planned"))).toEqual([{ status: "failed", runId: "prr_11111111111111111111111111111111" }, [...target, "acquire", "append failed->failed @3/tip", "release"]]);
    expect(await verb(failPreparationOperationWith, of("running"))).toEqual([{ status: "refused", reason: "only a planned run can be failed directly; this run is running" }, target]);
    expect(await verb(pausePreparationOperationWith, of("running"))).toEqual([{ status: "paused", runId: "prr_11111111111111111111111111111111", transition: "appended" }, [...target, "acquire", "append paused->paused @3/tip", "release"]]);
    expect(await verb(pausePreparationOperationWith, of("paused"))).toEqual([{ status: "paused", runId: "prr_11111111111111111111111111111111", transition: "already-paused" }, target]);
    expect(await verb(resumePreparationOperationWith, of("paused"))).toEqual([{ status: "resumed", runId: "prr_11111111111111111111111111111111", transition: "appended" }, [...target, "acquire", "append resumed->running @3/tip", "release"]]);
    expect(await verb(resumePreparationOperationWith, of("running"))).toEqual([{ status: "resumed", runId: "prr_11111111111111111111111111111111", transition: "already-running" }, target]);
  });

  it("V2 a lock refusal is each verb's refusal; an accessor request is refused before any step", async () => {
    expect((await verb(pausePreparationOperationWith, { ...of("running"), acquire: false }))[0]).toEqual({ status: "refused", reason: "project lock is busy" });
    const log: string[] = [];
    const accessor = Object.defineProperty({}, "runId", { get: () => "prr_11111111111111111111111111111111", enumerable: true });
    const refused = await resumePreparationOperationWith(controlSteps(log), PRINCIPAL, accessor as never);
    expect([refused.status, log]).toEqual(["refused", []]);
  });
});

/** What the memory cancel steps answer. */
interface CancelWorld { located?: unknown; run?: unknown; write?: "created" | "exists"; advisory?: unknown }

/** Memory cancel steps over `world`, each call logged. */
function cancelSteps(log: string[], writes: unknown[], world: CancelWorld = {}): CancelSteps {
  return {
    locateManifest: async (runId) => { log.push(`locate ${runId}`); return (world.located ?? { ok: true, manifest: { workspaceId: "ws", runId: "prr_11111111111111111111111111111111" } }) as never; },
    readRunForManifest: async (manifest) => { log.push(`run ${manifest.runId}`); return (world.run ?? { ok: true, binding: BINDING, run: runIn("running") }) as never; },
    writeCancel: async (input) => { log.push(`write ${input.runId}`); writes.push(input); return world.write ?? "created"; },
    readCancel: async (workspaceId, runId) => { log.push(`reread ${workspaceId}/${runId}`); return (world.advisory ?? { status: "present" }) as never; },
  };
}

describe("cancel over its steps", () => {
  const cancel = async (world: CancelWorld = {}, principal: unknown = PRINCIPAL) => {
    const log: string[] = [], writes: unknown[] = [];
    const answer = await cancelPreparationOperationWith(cancelSteps(log, writes, world), principal as never, { runId: "prr_11111111111111111111111111111111" });
    return { answer, log, writes };
  };

  it("K1 locates, reads the run, then publishes a fresh advisory with the requester, an instant and a 16-byte nonce", async () => {
    const { answer, log, writes } = await cancel();
    expect([answer, log]).toEqual([{ status: "requested", runId: "prr_11111111111111111111111111111111", request: "created" }, ["locate prr_11111111111111111111111111111111", "run prr_11111111111111111111111111111111", "write prr_11111111111111111111111111111111"]]);
    expect(writes).toEqual([{ workspaceId: "ws", runId: "prr_11111111111111111111111111111111", requester: "operator", at: expect.any(String), nonce: expect.stringMatching(/^[0-9a-f]{32}$/) }]);
  });

  it("K2 refuses an inadmissible requester before any step, a failed lookup before the run, and a terminal run before the write", async () => {
    expect((await cancel({}, { ...(PRINCIPAL as object), id: "" })).log).toEqual([]);
    expect(await cancel({ located: { ok: false, reason: "no such run" } })).toMatchObject({ answer: { status: "refused", reason: "no such run" }, log: ["locate prr_11111111111111111111111111111111"] });
    expect(await cancel({ run: { ok: true, binding: BINDING, run: runIn("failed") } }))
      .toMatchObject({ answer: { status: "refused", reason: "this run is already terminal (failed); there is nothing to cancel" }, log: ["locate prr_11111111111111111111111111111111", "run prr_11111111111111111111111111111111"] });
  });

  it("K3 a collision re-reads the advisory: one present is already pending, one gone or unreadable refuses", async () => {
    const reread = ["locate prr_11111111111111111111111111111111", "run prr_11111111111111111111111111111111", "write prr_11111111111111111111111111111111", "reread ws/prr_11111111111111111111111111111111"];
    expect(await cancel({ write: "exists" })).toMatchObject({ answer: { status: "requested", request: "already-pending" }, log: reread });
    expect((await cancel({ write: "exists", advisory: { status: "absent" } })).answer).toMatchObject({ status: "refused", reason: expect.stringContaining("was settled while") });
    expect((await cancel({ write: "exists", advisory: { status: "unavailable" } })).answer).toMatchObject({ status: "refused", reason: expect.stringContaining("unreadable object") });
  });
});

describe("the compositions and the root forms", () => {
  it("B1 each composition reaches its lower body over its own seam, and carries the caller's lock as given", async () => {
    const seams = { readiness: { tag: "readiness" }, lookup: { tag: "lookup" }, runs: { tag: "runs" }, advisories: { tag: "advisories" } } as never as Record<string, never>;
    const ready = vi.spyOn(readiness, "resolveHostReadinessFrom").mockResolvedValue({ ready: true, reason: null });
    const resolve = vi.spyOn(lookup, "resolvePreparationRunFrom").mockResolvedValue({ ok: false, reason: "r" } as never);
    const append = vi.spyOn(runStore, "appendPreparationTransitionWith").mockResolvedValue({} as never);
    const callerLock = { acquire: async () => true, release: async () => {} };
    const steps = controlVerbStepsOver({ readiness: seams.readiness, lookup: seams.lookup, runs: seams.runs }, callerLock);
    await Promise.all([steps.hostReadiness(), steps.resolveRun("prr_11111111111111111111111111111111"), steps.appendTransition(BINDING, { stateVersion: 1, chainTip: "t" } as never, { type: "failed" } as never)]);
    expect([ready.mock.calls, resolve.mock.calls, append.mock.calls, steps.lock]).toEqual([
      [[seams.readiness]], [[seams.lookup, "prr_11111111111111111111111111111111"]], [[seams.runs, BINDING, { stateVersion: 1, chainTip: "t" }, { type: "failed" }]], callerLock,
    ]);
    const spies = [vi.spyOn(lookup, "locatePreparationManifestFrom"), vi.spyOn(lookup, "readPreparationRunForManifestFrom"),
      vi.spyOn(cancellation, "writePreparationCancelWith"), vi.spyOn(cancellation, "readPreparationCancelFrom")].map((spy) => spy.mockResolvedValue({} as never));
    const cancelOver = cancelStepsOver({ lookup: seams.lookup, advisories: seams.advisories });
    await Promise.all([cancelOver.locateManifest("prr_11111111111111111111111111111111"), cancelOver.readRunForManifest({ runId: "m" } as never), cancelOver.writeCancel({ runId: "w" } as never), cancelOver.readCancel("ws", "prr_11111111111111111111111111111111" as never)]);
    expect(spies.map((spy) => spy.mock.calls)).toEqual([[[seams.lookup, "prr_11111111111111111111111111111111"]], [[seams.lookup, { runId: "m" }]], [[seams.advisories, { runId: "w" }]], [[seams.advisories, "ws", "prr_11111111111111111111111111111111"]]]);
  });

  it("B2 the root form reaches every incumbent root reader, the lock and the writer with exact arguments, in order", async () => {
    const { order, note } = orderedStubs();
    const ready = vi.spyOn(readiness, "resolveHostReadiness").mockImplementation(note("ready", { ready: true, reason: null }));
    const resolve = vi.spyOn(lookup, "resolvePreparationRun").mockImplementation(note("run", { ok: true, binding: BINDING, run: runIn("planned") } as never));
    const acquire = vi.spyOn(lockGate, "acquireMutationLock").mockImplementation(note("acquire", true));
    const append = vi.spyOn(runStore, "appendPreparationTransitionLocked").mockImplementation(note("append", {} as never));
    const release = vi.spyOn(lock, "releaseLock").mockImplementation(note("release", undefined));
    expect(await failPreparationOperation("/project", PRINCIPAL, { runId: "prr_11111111111111111111111111111111" })).toEqual({ status: "failed", runId: "prr_11111111111111111111111111111111" });
    expect(order).toEqual(["ready", "run", "acquire", "append", "release"]);
    expect([ready.mock.calls, resolve.mock.calls, acquire.mock.calls, release.mock.calls]).toEqual([[["/project"]], [["/project", "prr_11111111111111111111111111111111"]], [["/project", "ordinary"]], [["/project"]]]);
    expect(append.mock.calls[0]?.slice(0, 3)).toEqual(["/project", BINDING, { stateVersion: 3, chainTip: "tip" }]);
  });

  it("B3 the cancel root form reaches the incumbent lookup, run read, writer and re-read with exact arguments", async () => {
    const manifest = { workspaceId: "ws", runId: "prr_11111111111111111111111111111111" };
    const locate = vi.spyOn(lookup, "locatePreparationManifest").mockResolvedValue({ ok: true, manifest } as never);
    const run = vi.spyOn(lookup, "readPreparationRunForManifest").mockResolvedValue({ ok: true, binding: BINDING, run: runIn("running") } as never);
    const write = vi.spyOn(cancellation, "writePreparationCancelLockFree").mockResolvedValue("exists");
    const reread = vi.spyOn(cancellation, "readPreparationCancel").mockResolvedValue({ status: "present" } as never);
    expect(await cancelPreparationOperation("/project", PRINCIPAL, { runId: "prr_11111111111111111111111111111111" })).toEqual({ status: "requested", runId: "prr_11111111111111111111111111111111", request: "already-pending" });
    expect([locate.mock.calls, run.mock.calls, reread.mock.calls]).toEqual([[["/project", "prr_11111111111111111111111111111111"]], [["/project", manifest]], [["/project", "ws", "prr_11111111111111111111111111111111"]]]);
    expect(write.mock.calls).toEqual([["/project", { workspaceId: "ws", runId: "prr_11111111111111111111111111111111", requester: "operator", at: expect.any(String), nonce: expect.any(String) }]]);
  });
});

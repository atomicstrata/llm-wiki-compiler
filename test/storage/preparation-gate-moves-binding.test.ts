/**
 * @file test/storage/preparation-gate-moves-binding.test.ts
 * @description The runner's gate moves and the `gate` operation as ONE body each
 * over steps that take no project root: `blockAtGateWith` and
 * `resumeFromGateWith` over `GateDriverSteps`, and `gatePreparationOperationWith`
 * over `GateOperationSteps`. This file uses them, which exist only after each
 * was given its steps, so it has NO before-edit run.
 *
 * HOW IT IS BUILT. Memory steps log every call, so each refusal, the lock's
 * acquire/release pairing and the order of reads and the append are pinned; the
 * transition and the projected summary each move appends are read back. The
 * proof author is stubbed in the operation cases, so its sequencing is shown and
 * not its digests. The compositions are shown reaching each lower body over its
 * own seam, and the root forms every incumbent with exact arguments.
 *
 * NOT SHOWN HERE: the proof's digests and grant charge, the authority assembly
 * and the append's own fences; the gate, gate-binding and run-store suites show
 * those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as lockGate from "../../src/operation-bundles/lock-gate.js";
import { blockAtGate, blockAtGateWith, gateDriverStepsOver, resumeFromGateWith, type GateDriverSteps } from "../../src/preparations/gate-driver.js";
import * as gates from "../../src/preparations/gates.js";
import * as runStore from "../../src/preparations/run-store.js";
import * as gateAuthority from "../../src/preparations/service-gate-authority.js";
import { gateOperationStepsOver, gatePreparationOperation, gatePreparationOperationWith, type GateOperationSteps } from "../../src/preparations/service-gate.js";
import * as readiness from "../../src/preparations/service-readiness.js";
import * as lookup from "../../src/preparations/service-run-lookup.js";
import * as lock from "../../src/utils/lock.js";
import { orderedStubs } from "./call-log.js";
import { spyBlockingLockedRunRead } from "./preparation-lock-spies.js";

afterEach(() => { vi.restoreAllMocks(); });

const PLAN = `sha256:${"5".repeat(64)}`;
const BINDING = { workspaceId: "ws", runId: "run_1" } as never;
const ACTOR = { id: "operator", surface: "sdk" } as const;
const GATE = { logicalPhaseId: "review", gateId: "g", disposition: "required", phaseInstanceId: "phi_g", currentPlanDigest: PLAN } as never;
/** A run in `state` carrying `gateProofs`, with the one transition its predecessor is read from. */
const runIn = (state: string, gateProofs: unknown[] = []) =>
  ({ state, stateVersion: 2, transitions: [{ contentHash: "tip" }], gateProofs, phaseSummaries: [] }) as never;
const APPROVED = { gateId: "g", decisionIndex: 0, decision: "approved", planDigest: PLAN };

/** Memory gate-driver steps answering `read`, each call logged; the append returns the projection of the read run. */
function driverSteps(log: string[], read: unknown, appendFault?: Error): GateDriverSteps {
  return {
    lock: { acquire: async () => { log.push("acquire"); }, release: async () => { log.push("release"); } },
    readRun: async () => { log.push("read"); return read as never; },
    appendProjected: async (_binding, expected, input, project) => {
      log.push(`append ${input.stateAfter} ${(input.payload as { phaseState: string }).phaseState} @${expected.stateVersion}/${expected.chainTip}`);
      if (appendFault) throw appendFault;
      return project((read as { run: never }).run) as never;
    },
  };
}

describe("the runner's gate moves over their steps", () => {
  const move = async (op: typeof blockAtGateWith, read: unknown, fault?: Error) => {
    const log: string[] = [];
    const outcome = await op(driverSteps(log, read, fault), BINDING, GATE, ACTOR, "2026-10-14T00:00:00.000Z").catch((error: Error) => error.message);
    return [typeof outcome === "string" ? outcome : outcome.status === "moved" ? outcome.run.phaseSummaries : outcome.reason, log];
  };
  const summary = (state: string) => [expect.objectContaining({ phaseInstanceId: "phi_g", logicalPhaseId: "review", state, disposition: "required" })];

  it("D1 block reads under the lock and appends awaiting-gate from running or planned; anything else refuses, always released", async () => {
    for (const state of ["running", "planned"]) {
      expect(await move(blockAtGateWith, { status: "ok", run: runIn(state) })).toEqual([summary("awaiting-gate"), ["acquire", "read", "append awaiting-gate awaiting-gate @2/tip", "release"]]);
    }
    expect(await move(blockAtGateWith, { status: "ok", run: runIn("paused") })).toEqual(["run is paused, not running", ["acquire", "read", "release"]]);
    expect(await move(blockAtGateWith, { status: "unavailable" })).toEqual(["run unreadable: unavailable", ["acquire", "read", "release"]]);
    expect(await move(blockAtGateWith, { status: "ok", run: runIn("running") }, new Error("fenced")))
      .toEqual(["fenced", ["acquire", "read", "append awaiting-gate awaiting-gate @2/tip", "release"]]);
  });

  it("D2 resume needs awaiting-gate and an operative approval, then settles the gate instance and returns to running", async () => {
    expect(await move(resumeFromGateWith, { status: "ok", run: runIn("running") })).toEqual(["run is running, not awaiting-gate", ["acquire", "read", "release"]]);
    expect(await move(resumeFromGateWith, { status: "ok", run: runIn("awaiting-gate") })).toEqual(["gate g has no operative approval", ["acquire", "read", "release"]]);
    expect(await move(resumeFromGateWith, { status: "ok", run: runIn("awaiting-gate", [APPROVED]) }))
      .toEqual([summary("succeeded"), ["acquire", "read", "append running succeeded @2/tip", "release"]]);
  });
});

/** What the memory operation steps answer. */
interface World { ready?: boolean; acquire?: boolean | Error; run?: unknown; authority?: unknown }

/** Memory gate-operation steps over `world`, each call logged. */
function operationSteps(log: string[], world: World = {}): GateOperationSteps {
  return {
    hostReadiness: async () => { log.push("ready"); return world.ready === false ? { ready: false, reason: "no key" } : { ready: true, reason: null }; },
    lock: {
      acquire: async () => { log.push("acquire"); if (world.acquire instanceof Error) throw world.acquire; return world.acquire ?? true; },
      release: async () => { log.push("release"); },
    },
    resolveRun: async (runId) => { log.push(`run ${runId}`); return (world.run ?? { ok: true, binding: BINDING, run: runIn("awaiting-gate") }) as never; },
    gateAuthority: async (_binding, _run, gateId) => { log.push(`authority ${gateId}`); return (world.authority ?? { ok: true, authoritative: { tag: "auth" } }) as never; },
    appendProjected: async (_binding, expected, input, project) => {
      log.push(`append ${input.type} @${expected.stateVersion}`);
      return project(runIn("awaiting-gate")) as never;
    },
  };
}

const DECIDER = { id: "operator", surface: "sdk", grants: ["preparation.gate.decide"] } as never;
const REQUEST = { runId: "run_1", gateId: "g", decision: "approved" } as const;
const PROOF = { gateProofId: "gp_1", gateId: "g", decision: "approved", decisionIndex: 0, planDigest: PLAN };

describe("the gate operation over its steps", () => {
  const decide = async (world: World = {}, principal: unknown = DECIDER, request: object = REQUEST) => {
    const log: string[] = [];
    return [await gatePreparationOperationWith(operationSteps(log, world), principal as never, request as never), log];
  };

  it("G1 reads readiness, takes the review lock, resolves the run and its authority, appends the proof, then releases", async () => {
    const author = vi.spyOn(gates, "authorGateProof").mockReturnValue({ summary: PROOF } as never);
    expect(await decide()).toEqual([
      { status: "recorded", runId: "run_1", gateId: "g", gateProofId: "gp_1", decision: "approved", decisionIndex: 0 },
      ["ready", "acquire", "run run_1", "authority g", "append gate-decided @2", "release"],
    ]);
    expect(author.mock.calls[0]?.[0]).toMatchObject({ choice: "approved", decisionIndex: 0, authoritative: { tag: "auth" } });
  });

  it("G2 refuses an ungranted caller before any step, and an unready project or either lock refusal without releasing", async () => {
    expect((await decide({}, { ...(DECIDER as object), grants: [] }))[1]).toEqual([]);
    expect(await decide({ ready: false })).toEqual([{ status: "refused", reason: "no key" }, ["ready"]]);
    expect(await decide({ acquire: false })).toEqual([{ status: "refused", reason: "project lock is busy" }, ["ready", "acquire"]]);
    expect(await decide({ acquire: new lockGate.RecoveryGateError("x" as never, "reset pending") })).toEqual([{ status: "refused", reason: "reset pending" }, ["ready", "acquire"]]);
  });

  it("G3 under the lock: an unresolved run, a non-recordable state, an unbound authority and a gate-shaped authoring fault all refuse and release", async () => {
    const released = (...steps: string[]) => ["ready", "acquire", ...steps, "release"];
    expect(await decide({ run: { ok: false, reason: "no such run" } })).toEqual([{ status: "refused", reason: "no such run" }, released("run run_1")]);
    expect((await decide({ run: { ok: true, binding: BINDING, run: runIn("succeeded") } }))[1]).toEqual(released("run run_1"));
    expect(await decide({ authority: { ok: false, reason: "no gate" } })).toEqual([{ status: "refused", reason: "no gate" }, released("run run_1", "authority g")]);
    vi.spyOn(gates, "authorGateProof").mockImplementation(() => { throw new gates.GateAuthorityError("unknown-gate-kind" as never); });
    expect((await decide())[1]).toEqual(released("run run_1", "authority g"));
  });
});

describe("the compositions and the root forms", () => {
  it("B1 each composition reaches its lower body over its own seam, and carries the caller's lock as given", async () => {
    const seams = { runs: { tag: "runs" }, writes: { tag: "writes" }, readiness: { tag: "readiness" }, lookup: { tag: "lookup" }, manifests: { tag: "manifests" } } as never as Record<string, never>;
    const read = vi.spyOn(runStore, "readPreparationRunFrom").mockResolvedValue({ status: "absent" } as never);
    const append = vi.spyOn(runStore, "appendPreparationTransitionWith").mockResolvedValue({} as never);
    const ready = vi.spyOn(readiness, "resolveHostReadinessFrom").mockResolvedValue({ ready: true, reason: null });
    const resolve = vi.spyOn(lookup, "resolvePreparationRunFrom").mockResolvedValue({ ok: false, reason: "r" } as never);
    const authority = vi.spyOn(gateAuthority, "resolveGateAuthorityFrom").mockResolvedValue({ ok: false, reason: "a" });
    const [driverLock, reviewLock] = [{ acquire: async () => {}, release: async () => {} }, { acquire: async () => true, release: async () => {} }];
    const driver = gateDriverStepsOver({ runs: seams.runs, writes: seams.writes }, driverLock);
    const operation = gateOperationStepsOver({ readiness: seams.readiness, lookup: seams.lookup, manifests: seams.manifests, writes: seams.writes }, reviewLock);
    const project: runStore.PreparationRunContentProjector = (content) => content;
    await Promise.all([driver.readRun(BINDING), driver.appendProjected(BINDING, {} as never, { type: "x" } as never, project),
      operation.hostReadiness(), operation.resolveRun("run_1"), operation.gateAuthority(BINDING, {} as never, "g")]);
    expect([read.mock.calls, append.mock.calls, ready.mock.calls, resolve.mock.calls, authority.mock.calls, driver.lock, operation.lock]).toEqual([
      [[seams.runs, BINDING]], [[seams.writes, BINDING, {}, { type: "x" }, project]], [[seams.readiness]], [[seams.lookup, "run_1"]],
      [[seams.manifests, BINDING, {}, "g"]], driverLock, reviewLock,
    ]);
  });

  it("B2 block's root form reaches the blocking lock, the reader and the projected writer with exact arguments, in order", async () => {
    const stubs = orderedStubs();
    const { acquire, read, release } = spyBlockingLockedRunRead(stubs, runIn("running"));
    const append = vi.spyOn(runStore, "appendProjectedTransitionLocked").mockImplementation(stubs.note("append", runIn("awaiting-gate")));
    const { order } = stubs;
    expect((await blockAtGate("/project", BINDING, GATE, ACTOR, "2026-10-14T00:00:00.000Z")).status).toBe("moved");
    expect([order, acquire.mock.calls, read.mock.calls, release.mock.calls]).toEqual([
      ["acquire", "read", "append", "release"], [["/project", "ordinary"]], [["/project", BINDING]], [["/project"]],
    ]);
    expect(append.mock.calls[0]?.slice(0, 3)).toEqual(["/project", BINDING, { stateVersion: 2, chainTip: "tip" }]);
  });

  it("B3 the gate operation's root form reaches every incumbent with exact arguments", async () => {
    vi.spyOn(gates, "authorGateProof").mockReturnValue({ summary: PROOF } as never);
    const ready = vi.spyOn(readiness, "resolveHostReadiness").mockResolvedValue({ ready: true, reason: null });
    const acquire = vi.spyOn(lockGate, "acquireMutationLock").mockResolvedValue(true);
    const resolve = vi.spyOn(lookup, "resolvePreparationRun").mockResolvedValue({ ok: true, binding: BINDING, run: runIn("awaiting-gate") } as never);
    const authority = vi.spyOn(gateAuthority, "resolveGateAuthority").mockResolvedValue({ ok: true, authoritative: {} } as never);
    const append = vi.spyOn(runStore, "appendProjectedTransitionLocked").mockImplementation(async (_r, _b, _e, _i, project) => project(runIn("awaiting-gate")) as never);
    const release = vi.spyOn(lock, "releaseLock").mockResolvedValue(undefined);
    expect((await gatePreparationOperation("/project", DECIDER, REQUEST)).status).toBe("recorded");
    expect([ready.mock.calls, acquire.mock.calls, resolve.mock.calls, release.mock.calls]).toEqual([[["/project"]], [["/project", "review"]], [["/project", "run_1"]], [["/project"]]]);
    expect([authority.mock.calls[0]?.slice(0, 2), authority.mock.calls[0]?.[3], append.mock.calls[0]?.slice(0, 3)])
      .toEqual([["/project", BINDING], "g", ["/project", BINDING, { stateVersion: 2, chainTip: "tip" }]]);
  });
});

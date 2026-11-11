/**
 * @file test/storage/preparation-attempt-execution-binding.test.ts
 * @description One phase attempt as ONE body over steps that take no project
 * root: `executePhaseAttemptWith` over `AttemptExecutionSteps`. This file uses
 * it, which exists only after the executor was given its steps, so it has NO
 * before-edit run.
 *
 * HOW IT IS BUILT. One preparation is staged on real disk, once, and its run
 * and manifest are read back; memory steps then answer from those values,
 * applying each projected append to the held run, so the real seal, lease
 * fence, revalidation and projectors run. Every call is logged, so the two
 * locked sections, the leg between them, each busy refusal, the capture
 * refusal and the settlement's isolation are pinned in order. The composition
 * is shown reaching each store's own body, and the root form the incumbents with
 * exact arguments.
 *
 * NOT SHOWN HERE: the drift, bound and effect policy (the attempt suites), the
 * custody publication and the cancellation settlement themselves.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as withMutationLock from "../../src/operation-bundles/with-mutation-lock.js";
import * as cancelSettlement from "../../src/preparations/attempts/cancel-settlement.js";
import * as custody from "../../src/preparations/attempts/custody.js";
import {
  attemptExecutionStepsOver, executePhaseAttempt, executePhaseAttemptWith, type AttemptExecutionSteps,
} from "../../src/preparations/attempts/execute.js";
import * as cancellation from "../../src/preparations/cancellation.js";
import * as manifestStore from "../../src/preparations/manifest-store.js";
import * as runStore from "../../src/preparations/run-store.js";
import type { PreparationRunV1 } from "../../src/preparations/run-types.js";
import { LockBusyError } from "../../src/utils/lock.js";
import { attemptRequest, stagePreparation, succeededLeg, type StagedPreparation } from "../preparations/attempt-fixture.js";

afterEach(() => { vi.restoreAllMocks(); });

let STAGED: StagedPreparation, RUN: PreparationRunV1, MANIFEST: manifestStore.PreparationManifestRead;
beforeAll(async () => {
  STAGED = await stagePreparation();
  const read = await runStore.readPreparationRun(STAGED.root, STAGED.binding);
  if (read.status !== "ok") throw new Error("the staged run did not read back");
  RUN = read.run;
  MANIFEST = await manifestStore.readPreparationManifest(STAGED.root, STAGED.binding.workspaceId, STAGED.binding.preparationId);
});
afterAll(() => STAGED.cleanup());

/** What the memory steps answer, beyond the held run and manifest. */
interface World { busy?: number; absent?: boolean; settleFault?: boolean }

/** Memory steps over the held run, applying each projected append; every call logged. */
function stepsOf(log: string[], world: World = {}): AttemptExecutionSteps {
  let run = RUN;
  let locks = 0;
  return {
    lock: async (work) => { log.push("lock"); if (++locks === world.busy) throw new LockBusyError(1); return work(); },
    readRun: async () => { log.push("run"); return (world.absent ? { status: "absent" } : { status: "ok", run }) as never; },
    readManifest: async () => { log.push("manifest"); return MANIFEST; },
    appendProjected: async (_binding, expected, input, project) => {
      log.push(`append ${input.type} @${expected.stateVersion}`);
      run = { ...(project(run) as PreparationRunV1), state: input.stateAfter, stateVersion: run.stateVersion + 1,
        transitions: [...run.transitions, { contentHash: `tip-${run.stateVersion + 1}` }] } as PreparationRunV1;
      return run;
    },
    publishCustody: async () => { log.push("custody"); return true; },
    cancellationRequested: async () => { log.push("probe"); return false; },
    settleCancellation: async (delivered) => { log.push(`settle ${String(delivered)}`); if (world.settleFault) throw new Error("settle fault"); },
  };
}

/** One attempt over `world` whose leg logs itself: the outcome status (and reason) and the log. */
async function attempt(world: World = {}, request: object = {}): Promise<[string, string[]]> {
  const log: string[] = [];
  const leg = async () => { log.push("leg"); return succeededLeg(); };
  const { root: _root, ...body } = attemptRequest(STAGED, { leg });
  const outcome = await executePhaseAttemptWith(stepsOf(log, world), { ...body, ...request } as never);
  return ["reason" in outcome ? `${outcome.status} ${outcome.reason}` : outcome.status, log];
}

/** The first locked section: the run, the manifest, and the intent append at the held run's version. */
const intent = () => ["lock", "run", "manifest", `append phase-started @${RUN.stateVersion}`];

describe("one phase attempt over its steps", () => {
  it("X1 seals under the lock, runs the leg unlocked, then revalidates, publishes, settles and acknowledges under the lock", async () => {
    expect(await attempt()).toEqual(["committed", [...intent(), "probe", "leg",
      "lock", "run", "manifest", "custody", `append phase-settled @${RUN.stateVersion + 1}`, "settle false"]]);
  });

  it("X2 a busy first lock is refused-busy with nothing read; a busy second lock parks reacquire-busy after the leg", async () => {
    expect(await attempt({ busy: 1 })).toEqual(["refused-busy", ["lock"]]);
    expect(await attempt({ busy: 2 })).toEqual(["parked reacquire-busy", [...intent(), "probe", "leg", "lock"]]);
  });

  it("X3 an unreadable run parks inside the first lock; an accessor request parks before any step", async () => {
    expect(await attempt({ absent: true })).toEqual(["parked run-absent", ["lock", "run"]]);
    const accessor = Object.defineProperty({}, "binding", { get: () => STAGED.binding, enumerable: true });
    const log: string[] = [];
    const outcome = await executePhaseAttemptWith(stepsOf(log), accessor as never);
    expect([outcome, log]).toEqual([{ status: "parked", reason: "request-not-capturable" }, []]);
  });

  it("X4 a failed cancellation settlement does not undo the committed attempt", async () => {
    const [status, log] = await attempt({ settleFault: true });
    expect([status, log.at(-1)]).toEqual(["committed", "settle false"]);
  });
});

describe("the composition and the root form", () => {
  it("B1 the composition reaches each store's own body over its own seam, settling for the given request", async () => {
    const seams = { runs: { tag: "runs" }, manifests: { tag: "manifests" }, writes: { tag: "writes" }, evidence: { tag: "evidence" },
      advisories: { tag: "advisories" }, settlement: { tag: "settlement" } } as never as Record<string, never>;
    const spies = [
      vi.spyOn(runStore, "readPreparationRunFrom"), vi.spyOn(manifestStore, "readPreparationManifestFrom"),
      vi.spyOn(runStore, "appendPreparationTransitionWith"), vi.spyOn(custody, "publishCustodyWith"),
      vi.spyOn(cancellation, "preparationCancellationRequestedFrom"), vi.spyOn(cancelSettlement, "settleAttemptCancellationWith"),
    ].map((spy) => spy.mockResolvedValue({} as never));
    const callerLock = vi.fn();
    const request = { binding: STAGED.binding, principal: { id: "p", surface: "cli" }, clock: { now: () => "t" } } as never;
    const steps = attemptExecutionStepsOver(seams as never, callerLock as never, request);
    await Promise.all([steps.readRun(STAGED.binding), steps.readManifest("ws", "prep" as never), steps.appendProjected(STAGED.binding, {} as never, {} as never, (c) => c),
      steps.publishCustody({} as never, [], 1), steps.cancellationRequested("ws", "run" as never), steps.settleCancellation(true)]);
    expect([spies.map((spy) => spy.mock.calls[0]?.[0]), spies[5]!.mock.calls[0]?.slice(1), steps.lock]).toEqual([
      [seams.runs, seams.manifests, seams.writes, seams.evidence, seams.advisories, seams.settlement], [request, true], callerLock,
    ]);
  });

  it("B2 the root form locks and reads with the captured root, and a non-string root parks before any lock", async () => {
    const lock = vi.spyOn(withMutationLock, "withAttemptMutationLock").mockImplementation(async (_root, work) => work());
    const read = vi.spyOn(runStore, "readPreparationRun").mockResolvedValue({ status: "absent" } as never);
    expect(await executePhaseAttempt(attemptRequest(STAGED, { root: "/project" }))).toEqual({ status: "parked", reason: "run-absent" });
    expect([lock.mock.calls.map((call) => call[0]), read.mock.calls]).toEqual([["/project"], [["/project", STAGED.binding]]]);
    expect(await executePhaseAttempt(attemptRequest(STAGED, { root: 7 as never }))).toEqual({ status: "parked", reason: "request-not-capturable" });
    expect(lock.mock.calls).toHaveLength(1);
  });
});

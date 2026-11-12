/**
 * @file test/storage/operation-drive-binding.test.ts
 * @description The operator recovery drives and the registered-project gate as
 * ONE body each over steps that take no project root:
 * `operationResumeWith` / `operationCompensateWith(OperationDriveSteps)` and
 * `withRegisteredProjectLockWith(RegisteredProjectGate)`.
 *
 * HOW IT IS BUILT. A real bundle is staged on disk and its inventory answered
 * from memory steps that log every call, with the lock, the run, the advisory
 * and the three locked settlement entries as doubles. That pins the target
 * refusal, the busy lock, recover-versus-resume from the run's own state, the
 * cancellation trigger, the release on every exit and the exit code. The gate
 * body is pinned the same way. The last cases show the root forms reaching each
 * incumbent with the root.
 *
 * NOT SHOWN HERE: the settlement seams, the lock gate and the portable-directory
 * look themselves; the operation CLI, recovery and gate suites show those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as cancelRequest from "../../src/operation-bundles/cancel-request.js";
import { scanOperationInventory, type OperationInventory } from "../../src/operation-bundles/capacity.js";
import * as compensation from "../../src/operation-bundles/compensation.js";
import type { OperationActionResult } from "../../src/operation-bundles/executor.js";
import * as lockGate from "../../src/operation-bundles/lock-gate.js";
import * as recovery from "../../src/operation-bundles/recovery.js";
import {
  withRegisteredProjectLock, withRegisteredProjectLockWith, type RegisteredProjectGate,
} from "../../src/operation-bundles/registered-project-lock.js";
import {
  operationCompensateCommand, operationCompensateWith, operationResumeCommand, operationResumeWith, type OperationDriveSteps,
} from "../../src/commands/operation/drive.js";
import * as render from "../../src/commands/operation/render.js";
import * as runtimeFactory from "../../src/operation-bundles/runtime-factory.js";
import * as pendingGate from "../../src/portable/host/pending-gate.js";
import * as lock from "../../src/utils/lock.js";
import { stageSourceBundle, type StagedBundle } from "../operation-bundles/executor-fixtures.js";
import { tempRootTracker } from "../temp-roots.js";

const tracker = tempRootTracker();
afterEach(async () => { vi.restoreAllMocks(); await tracker.cleanup(); });

const SETTLED = { bundleId: "b", state: "succeeded", problems: [] } as unknown as OperationActionResult;
const KEY = `sha256:${"1".repeat(64)}`;
/** The host runtime the memory steps supply; the body must carry THIS one to every settlement. */
const MEMORY_RUNTIME = { tag: "memory runtime" } as never;

/** A staged bundle and its inventory, with the drive's output captured into `log`. */
async function stagedDrive(log: string[]): Promise<{ root: string; staged: StagedBundle; inventory: OperationInventory }> {
  const root = await tracker.create("operation-drive-", { real: true });
  const staged = await stageSourceBundle(root);
  vi.spyOn(render, "reportFailure").mockImplementation((message) => { log.push(`failure ${message}`); return 1; });
  vi.spyOn(render, "renderActionResult").mockImplementation(() => { log.push("rendered"); });
  vi.spyOn(render, "emitJson").mockImplementation(() => { log.push("json"); });
  return { root, staged, inventory: await scanOperationInventory(root) };
}

/** What the memory drive steps answer. */
interface DriveWorld { keyEpoch?: string | null; state?: string; cancel?: "present" | "absent"; taken?: boolean; fault?: Error }

/** Memory drive steps over the staged inventory; each call logged. */
function driveSteps(inventory: OperationInventory, log: string[], world: DriveWorld = {}): OperationDriveSteps {
  const carried = (request: { runtime: unknown }) => (request.runtime === MEMORY_RUNTIME ? "memory runtime" : "OTHER runtime");
  const settle = (name: string) => async (request: { runtime: unknown }) => { log.push(`${name} ${carried(request)}`); if (world.fault) throw world.fault; return SETTLED; };
  return {
    inventory: async () => { log.push("inventory"); return inventory; },
    keyEpoch: async () => { log.push("key"); return (world.keyEpoch === undefined ? KEY : world.keyEpoch) as never; },
    run: async () => { log.push("run"); return { status: "ok", run: { state: world.state ?? "recovery-required" } } as never; },
    lock: { acquire: async () => { log.push("acquire"); return world.taken ?? true; }, release: async () => { log.push("release"); } },
    readCancel: async () => { log.push("cancel?"); return (world.cancel === "present" ? { status: "present", request: {} } : { status: "absent" }) as never; },
    request: (resolved, grants) => { log.push(`request ${grants.join(",")}`); return { bundleId: resolved.bundleId, runtime: MEMORY_RUNTIME } as never; },
    recover: settle("recover"), resume: settle("resume"),
    compensate: async (request, trigger) => { log.push(`compensate ${trigger} ${carried(request)}`); return SETTLED; },
  };
}

describe("the recovery drives as root-free bodies", () => {
  it("D1 resume re-drives an applying run by observation and resumes any other, both under the lock", async () => {
    const log: string[] = [];
    const { staged, inventory } = await stagedDrive(log);
    const req = "request operation-bundle.approve";
    for (const [world, settled] of [[{ state: "applying" }, [req, "key", "run", "recover memory runtime"]], [{}, [req, "key", "run", "resume memory runtime"]],
      [{ keyEpoch: null }, [req, "key", "resume memory runtime"]]] as const) {
      log.length = 0;
      expect(await operationResumeWith(driveSteps(inventory, log, world), staged.bundleId)).toBe(0);
      expect(log).toEqual(["inventory", "acquire", ...settled, "release", "rendered"]);
    }
  });

  it("D2 refuses an unknown target before the lock and a busy lock without releasing, and releases after a fault", async () => {
    const log: string[] = [];
    const { staged, inventory } = await stagedDrive(log);
    expect(await operationResumeWith(driveSteps(inventory, log), "nothing")).toBe(1);
    expect(log).toEqual(["inventory", 'failure No operation bundle or run matches "nothing".']);
    log.length = 0;
    expect(await operationResumeWith(driveSteps(inventory, log, { taken: false }), staged.bundleId)).toBe(1);
    expect(log).toEqual(["inventory", "acquire", "failure Another llmwiki process is using this project; not driving recovery."]);
    log.length = 0;
    await expect(operationResumeWith(driveSteps(inventory, log, { fault: new Error("EIO") }), staged.bundleId)).rejects.toThrow("EIO");
    expect(log.at(-1)).toBe("release");
  });

  it("D3 compensate takes the cancellation trigger only from a pending advisory, and emits JSON when asked", async () => {
    const log: string[] = [];
    const { staged, inventory } = await stagedDrive(log);
    for (const [cancel, trigger] of [["present", "cancellation"], ["absent", "apply-failure"]] as const) {
      log.length = 0;
      expect(await operationCompensateWith(driveSteps(inventory, log, { cancel }), staged.bundleId, { json: true })).toBe(0);
      expect(log).toEqual(["inventory", "acquire", "cancel?", "request operation-bundle.approve", `compensate ${trigger} memory runtime`, "release", "json"]);
    }
  });
});

/** A logging gate: registered or not, and an acquire that may refuse. */
const gateOf = (log: string[], registered: boolean, refusal?: Error): RegisteredProjectGate => ({
  registered: async () => { log.push("registered?"); return registered; },
  acquire: async () => { log.push("acquire"); if (refusal) throw refusal; },
  release: async () => { log.push("release"); },
});

describe("the registered-project gate as a root-free body", () => {
  it("G1 locks only a registered project, releases on every exit, and never writes past a refused gate", async () => {
    const run = async (registered: boolean, write: () => Promise<string>, refusal?: Error) => {
      const log: string[] = [];
      const outcome = await withRegisteredProjectLockWith(gateOf(log, registered, refusal), async () => { log.push("write"); return write(); }).catch((error: Error) => error.message);
      return [outcome, log];
    };
    expect(await run(false, async () => "ok")).toEqual(["ok", ["registered?", "write"]]);
    expect(await run(true, async () => "ok")).toEqual(["ok", ["registered?", "acquire", "write", "release"]]);
    expect(await run(true, async () => { throw new Error("disk full"); })).toEqual(["disk full", ["registered?", "acquire", "write", "release"]]);
    expect(await run(true, async () => "ok", new Error("publication intent unresolved"))).toEqual(["publication intent unresolved", ["registered?", "acquire"]]);
  });
});

describe("the drive request", () => {
  it("R1 the body never builds the CLI runtime itself: the request, and its runtime, come only from the steps", async () => {
    const cli = vi.spyOn(runtimeFactory, "createCliOperationRuntime");
    const log: string[] = [];
    const { staged, inventory } = await stagedDrive(log);
    await operationResumeWith(driveSteps(inventory, log), staged.bundleId);
    await operationCompensateWith(driveSteps(inventory, log), staged.bundleId);
    expect([cli.mock.calls.length, log.filter((line) => line.includes("runtime"))]).toEqual([0, ["resume memory runtime", "compensate apply-failure memory runtime"]]);
  });
});

/** The arguments of a spy's `index`th call, failing the case when that call never happened. */
function callOf(spy: { mock: { calls: unknown[][] } }, index = 0): unknown[] {
  expect(spy.mock.calls.length).toBeGreaterThan(index);
  return spy.mock.calls[index]!;
}

/** The value a spy's `index`th call returned, failing the case when that call never happened. */
function resultOf(spy: { mock: { results: Array<{ value: unknown }> } }, index: number): unknown {
  expect(spy.mock.results.length).toBeGreaterThan(index);
  return spy.mock.results[index]!.value;
}

describe("the root forms", () => {
  it("Z1 resume and compensate reach each incumbent with the root, the old arguments and the runtime the CLI factory built", async () => {
    const { root, staged } = await stagedDrive([]);
    const acquire = vi.spyOn(lockGate, "acquireMutationLock").mockResolvedValue(true);
    const release = vi.spyOn(lock, "releaseLock").mockResolvedValue(undefined);
    const resume = vi.spyOn(recovery, "resumeOperationRecoveryLocked").mockResolvedValue(SETTLED);
    const cancel = vi.spyOn(cancelRequest, "readCancelRequest");
    const compensate = vi.spyOn(compensation, "compensateOperationBundleLocked").mockResolvedValue(SETTLED);
    const cli = vi.spyOn(runtimeFactory, "createCliOperationRuntime");
    await operationResumeCommand(root, staged.bundleId);
    await operationCompensateCommand(root, staged.bundleId);
    const [resumeRoot, resumeRequest] = callOf(resume) as [string, { bundleId: string; runtime: unknown }];
    const [compensateRoot, compensateRequest, trigger] = callOf(compensate) as [string, { runtime: unknown }, string];
    expect([cli.mock.calls.length, resumeRequest.runtime, compensateRequest.runtime]).toEqual([2, resultOf(cli, 0), resultOf(cli, 1)]);
    expect([acquire.mock.calls, release.mock.calls]).toEqual([[[root, "recovery"], [root, "recovery"]], [[root], [root]]]);
    expect([resumeRoot, resumeRequest.bundleId]).toEqual([root, staged.bundleId]);
    expect([callOf(cancel)[0], compensateRoot, trigger]).toEqual([root, root, "apply-failure"]);
  });

  it("Z2 the registered-project gate reaches the portable-directory look and the blocking lock with the root, then releases it", async () => {
    const { root } = await stagedDrive([]);
    const release = vi.spyOn(lock, "releaseLock").mockResolvedValue(undefined);
    const portable = vi.spyOn(pendingGate, "hasPortableDirectory").mockResolvedValue(true);
    const blocking = vi.spyOn(lockGate, "acquireMutationLockBlocking").mockResolvedValue(undefined as never);
    expect(await withRegisteredProjectLock(root, async () => "written")).toBe("written");
    expect([portable.mock.calls, blocking.mock.calls, release.mock.calls]).toEqual([[[root]], [[root, "ordinary"]], [[root]]]);
  });
});

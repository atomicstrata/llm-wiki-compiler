/**
 * @file test/storage/product-apply-binding.test.ts
 * @description Product bundle apply as ONE body over its steps,
 * `applyProductBundleWith`, bound through `productApplyStepsOver`, with no
 * project directory. This file uses both, which exist only after the apply was
 * given steps of its own, so it has NO before-edit run.
 *
 * HOW IT IS BUILT. Memory steps answer the inventory, the host's gated lock and
 * the host's executor, and log every call, so the sequence (capture, resolve,
 * lock, approve-and-apply, release), every refusal (an accessor request, an
 * unknown target, a busy lock, each gate refusal) and what each must not do
 * (resolve, lock, release) are pinned, and the outcome projection is shown not
 * reclassifying the executor's state. The bound composition and the root form
 * are shown reaching their readers, lock and executor with exact arguments.
 *
 * NOT SHOWN HERE: the executor, the lock gate and the inventory scan themselves;
 * the operation-bundle and product apply suites show those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as bundleTarget from "../../src/operation-bundles/bundle-target.js";
import * as capacity from "../../src/operation-bundles/capacity.js";
import * as executor from "../../src/operation-bundles/executor.js";
import type { OperationActionResult } from "../../src/operation-bundles/executor.js";
import * as lockGate from "../../src/operation-bundles/lock-gate.js";
import { RecoveryGateError } from "../../src/operation-bundles/lock-gate.js";
import { operationManifestDigest } from "../../src/operation-bundles/manifest-parse.js";
import { REQUEST_CAPTURE_REFUSAL } from "../../src/preparations/service-request-capture.js";
import { applyProductBundle, applyProductBundleWith, productApplyStepsOver, type ProductApplySteps } from "../../src/products/apply.js";
import { JournalUnsafeError } from "../../src/trust/journal-recovery.js";
import * as lock from "../../src/utils/lock.js";

afterEach(() => { vi.restoreAllMocks(); });

const MANIFEST = { workspaceId: "ws", bundleId: "bundle-1", runId: "oprun-1" };
const DIGEST = operationManifestDigest(MANIFEST as never);
const INVENTORY = { manifests: [MANIFEST] } as never;
const AUTHORITY = { principal: { id: "operator" }, runtime: { adapters: [] } } as never;
const COUNTERS = { mutations: { attempted: 1, applied: 1, skipped: 0, failed: 0 } };
const SETTLED = { bundleId: "bundle-1", runId: "oprun-1", state: "succeeded", counters: COUNTERS, problems: [] } as unknown as OperationActionResult;
const REQUEST = { workspaceId: "ws", bundleId: "bundle-1", manifestDigest: DIGEST, ...(AUTHORITY as object) };

/** Memory steps: the lock answers `locked` (or throws it), the executor answers `result` (or throws it); each call logged. */
function stepsOf(log: string[], world: { locked?: boolean | Error; result?: OperationActionResult | Error } = {}): ProductApplySteps {
  return {
    loadInventory: async () => { log.push("inventory"); return INVENTORY; },
    acquireLock: async () => { log.push("lock"); if (world.locked instanceof Error) throw world.locked; return world.locked ?? true; },
    releaseLock: async () => { log.push("release"); },
    approveAndApply: async (target, authority) => {
      log.push(`apply ${JSON.stringify({ ...target, ...authority }) === JSON.stringify(REQUEST) && authority === AUTHORITY}`);
      if (world.result instanceof Error) throw world.result;
      return world.result ?? SETTLED;
    },
  };
}

/** Apply `bundle` over `world`: the outcome and the log. */
async function apply(bundle: unknown, world: Parameters<typeof stepsOf>[1] = {}): Promise<[unknown, string[]]> {
  const log: string[] = [];
  return [await applyProductBundleWith(stepsOf(log, world), AUTHORITY, bundle as never), log];
}

describe("the product apply's one body over memory steps", () => {
  it("P1 resolves by run id, bundle id or digest, locks, applies the resolved identities with the host's authority, then releases", async () => {
    const applied = { status: "applied", bundleId: "bundle-1", runId: "oprun-1", runState: "succeeded", mutations: COUNTERS.mutations, problems: [] };
    for (const bundle of ["oprun-1", "bundle-1", DIGEST]) {
      expect(await apply({ bundle })).toEqual([applied, ["inventory", "lock", "apply true", "release"]]);
    }
  });

  it("P2 refuses an accessor request before any read, an unknown target before the lock, and a busy lock without releasing", async () => {
    const accessor = Object.defineProperty({}, "bundle", { get: () => "oprun-1", enumerable: true });
    expect(await apply(accessor)).toEqual([{ status: "refused", reason: REQUEST_CAPTURE_REFUSAL }, []]);
    expect(await apply({ bundle: "nothing" })).toEqual([{ status: "refused", reason: 'No operation bundle or run matches "nothing".' }, ["inventory"]]);
    expect(await apply({ bundle: "oprun-1" }, { locked: false })).toEqual([{ status: "refused", reason: "project lock is busy" }, ["inventory", "lock"]]);
  });

  it("P3 answers each gate refusal with its own message, rethrows any other lock fault, and releases after an executor fault", async () => {
    const gate = new RecoveryGateError("recovery-required" as never, "bundle b0 needs recovery first");
    expect(await apply({ bundle: "oprun-1" }, { locked: gate })).toEqual([{ status: "refused", reason: gate.message }, ["inventory", "lock"]]);
    const journal = new JournalUnsafeError("torn page journal");
    expect((await apply({ bundle: "oprun-1" }, { locked: journal }))[0]).toEqual({ status: "refused", reason: journal.message });
    const fault = new Error("EIO");
    await expect(applyProductBundleWith(stepsOf([], { locked: fault }), AUTHORITY, { bundle: "oprun-1" })).rejects.toBe(fault);
    const log: string[] = [];
    await expect(applyProductBundleWith(stepsOf(log, { result: fault }), AUTHORITY, { bundle: "oprun-1" })).rejects.toBe(fault);
    expect(log).toEqual(["inventory", "lock", "apply true", "release"]);
  });

  it("P4 carries a parked or problem-bearing result as not-applied, never as a write", async () => {
    const parked = { ...SETTLED, state: "recovery-required" } as OperationActionResult;
    expect((await apply({ bundle: "oprun-1" }, { result: parked }))[0]).toEqual({
      status: "not-applied", bundleId: "bundle-1", runId: "oprun-1", runState: "recovery-required", mutations: COUNTERS.mutations, problems: [],
    });
    const problem = { ...SETTLED, problems: [{ code: "grant-missing", message: "no grant" }] } as unknown as OperationActionResult;
    expect((await apply({ bundle: "oprun-1" }, { result: problem }))[0]).toMatchObject({ status: "not-applied", problems: [{ code: "grant-missing", message: "no grant" }] });
  });
});

describe("the bound composition and the root form", () => {
  it("B1 the composition reads the inventory through the scan's own body and keeps the host's lock and executor as given", async () => {
    const scan = vi.spyOn(capacity, "scanOperationInventoryFrom").mockResolvedValue(INVENTORY);
    const log: string[] = [];
    const host = stepsOf(log);
    const inventory = {} as capacity.OperationInventoryReads;
    const approveAndApply = async (request: unknown) => { log.push(`apply ${JSON.stringify(request) === JSON.stringify(REQUEST)}`); return SETTLED; };
    const steps = productApplyStepsOver({ inventory, lock: host, approveAndApply });
    expect((await applyProductBundleWith(steps, AUTHORITY, { bundle: "oprun-1" }) as { status: string }).status).toBe("applied");
    expect([scan.mock.calls, log]).toEqual([[[inventory]], ["lock", "apply true", "release"]]);
  });

  it("B2 the root form reaches the incumbent inventory, lock, executor and release with the root and their old arguments", async () => {
    const inventory = vi.spyOn(bundleTarget, "loadOperationInventory").mockResolvedValue(INVENTORY);
    const acquire = vi.spyOn(lockGate, "acquireMutationLock").mockResolvedValue(true);
    const run = vi.spyOn(executor, "approveAndApplyOperationBundleLocked").mockResolvedValue(SETTLED);
    const release = vi.spyOn(lock, "releaseLock").mockResolvedValue(undefined);
    expect((await applyProductBundle({ root: "/project", ...(AUTHORITY as object) } as never, { bundle: "oprun-1" })).status).toBe("applied");
    expect([inventory.mock.calls, acquire.mock.calls, release.mock.calls]).toEqual([[["/project"]], [["/project", "review"]], [["/project"]]]);
    expect(run.mock.calls).toEqual([["/project", REQUEST]]);
  });

  it("B3 a host root moved during the apply: the lock is released at the root it was taken at, the executor reads the root when it runs", async () => {
    const deps = { root: "/project", ...(AUTHORITY as object) } as { root: string };
    vi.spyOn(bundleTarget, "loadOperationInventory").mockImplementation(async () => { deps.root = "/locked-here"; return INVENTORY; });
    const acquire = vi.spyOn(lockGate, "acquireMutationLock").mockImplementation(async () => { deps.root = "/run-here"; return true; });
    const run = vi.spyOn(executor, "approveAndApplyOperationBundleLocked").mockImplementation(async () => { deps.root = "/moved"; return SETTLED; });
    const release = vi.spyOn(lock, "releaseLock").mockResolvedValue(undefined);
    await applyProductBundle(deps as never, { bundle: "oprun-1" });
    expect([acquire.mock.calls[0]?.[0], run.mock.calls[0]?.[0], release.mock.calls]).toEqual(["/locked-here", "/run-here", [["/locked-here"]]]);
  });
});

/**
 * @file test/storage/handoff-binding.test.ts
 * @description The preparation handoff as ONE body over its steps,
 * `handoffPreparationWith` over `HandoffSteps`, bound through `handoffStepsOver`.
 * This file uses them, which exist only after the handoff was given steps of its
 * own, so it has NO before-edit run.
 *
 * HOW IT IS BUILT. A real preparation is staged to `handoff-ready` on a temp root
 * (the shared handoff fixture). The body runs over RECORDING steps that log each
 * call and delegate to the incumbent root forms for that root, so the real fresh
 * and resumed flows are pinned in order (lock, run, cancellation, manifest, dry
 * run, start, stage, created-bundle verification, append, release). The refusal
 * ladder runs over the same steps with single answers overridden. A fresh
 * handoff also runs over MEMORY alone: the preparation run's own leaf and key
 * captured once from disk, then read, authenticated and appended to through the
 * run store's own bodies over that memory, with an in-memory stand-in for the
 * Milestone A staging, and no root-form call at all. The bound
 * composition is shown reaching each store's body over its seam, and the root
 * form each incumbent with the root first.
 *
 * NOT SHOWN HERE: bundle compilation, the stores' own authentication and the lock
 * gate; the handoff, faults, capacity and operation-bundle suites show those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as lockGate from "../../src/operation-bundles/lock-gate.js";
import * as keyEpoch from "../../src/operation-bundles/key-epoch.js";
import * as opManifests from "../../src/operation-bundles/manifest-store.js";
import * as opRuns from "../../src/operation-bundles/run-store.js";
import * as stage from "../../src/operation-bundles/stage.js";
import * as cancellation from "../../src/preparations/cancellation.js";
import { handoffPreparation, handoffPreparationWith, handoffStepsOver, type HandoffSteps } from "../../src/preparations/handoff.js";
import * as prepManifests from "../../src/preparations/manifest-store.js";
import * as prepRuns from "../../src/preparations/run-store.js";
import * as lock from "../../src/utils/lock.js";
import { canonicalDigest } from "../../src/profile/templates/signing/canonical.js";
import { MAX_PREPARATION_RUN_BYTES } from "../../src/preparations/constants.js";
import { readPreparationKey } from "../../src/preparations/key-epoch.js";
import type { PreparationRunBinding } from "../../src/preparations/run-types.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { handoffRequest, stageReadyPreparation } from "../preparations/handoff-fixture.js";

const root = useTempRoot();
afterEach(() => { vi.restoreAllMocks(); });

/** Steps for `dir` that log each call by name and delegate to the incumbent root form, unless `override` answers it. */
function recording(dir: string, log: string[], override: Partial<HandoffSteps> = {}): HandoffSteps {
  const note = <A extends unknown[], R>(name: string, call: (...args: A) => R) => (...args: A): R => { log.push(name); return call(...args); };
  const real: HandoffSteps = {
    lock: { acquire: note("acquire", () => lockGate.acquireMutationLockBlocking(dir, "handoff")), release: note("release", () => lock.releaseLock(dir)) },
    readRun: note("run", (binding) => prepRuns.readPreparationRun(dir, binding)),
    cancellationRequested: note("cancel", (workspaceId, runId) => cancellation.preparationCancellationRequested(dir, workspaceId, runId)),
    readPreparationManifest: note("prep-manifest", (workspaceId, preparationId) => prepManifests.readPreparationManifest(dir, workspaceId, preparationId)),
    readOperationManifest: note("op-manifest", (workspaceId, bundleId) => opManifests.readOperationManifest(dir, workspaceId, bundleId)),
    readOperationKey: note("op-key", () => keyEpoch.readOperationKey(dir)),
    readOperationRun: note("op-run", (binding) => opRuns.readOperationRun(dir, binding)),
    stage: note("stage", (request) => { log.push(request.dryRun ? "dry-run" : "real"); return stage.stageOperationBundleLocked(dir, request); }),
    appendStarted: note("started", (binding, expected, input) => prepRuns.appendHandoffStartedTransitionLocked(dir, binding, expected, input)),
    appendHandoff: note("handed-off", (binding, expected, input) => prepRuns.appendHandoffTransitionLocked(dir, binding, expected, input)),
  };
  return { ...real, ...override };
}

const FRESH = ["acquire", "run", "cancel", "prep-manifest", "stage", "dry-run", "started", "stage", "real",
  "op-manifest", "op-key", "op-run", "run", "handed-off", "release"];

describe("the handoff's one body over recording steps", () => {
  it("H1 a fresh handoff runs in the incumbent order: lock, run, cancel, manifest, dry run, start, stage, verify, append, release", async () => {
    const binding = await stageReadyPreparation(root.dir);
    const log: string[] = [];
    expect((await handoffPreparationWith(recording(root.dir, log), handoffRequest(binding))).outcome).toBe("handed-off");
    expect(log).toEqual(FRESH);
  });

  it("H2 a resume after handoff-started never asks the cancellation, and re-stages the reserved bundle", async () => {
    const binding = await stageReadyPreparation(root.dir);
    const crash = new Error("crash after start");
    const request = handoffRequest(binding, "ada", { faultsForTest: { afterHandoffStarted: async () => { throw crash; } } });
    await expect(handoffPreparationWith(recording(root.dir, []), request)).rejects.toBe(crash);
    const log: string[] = [];
    const cancelled = { cancellationRequested: async () => true };
    expect((await handoffPreparationWith(recording(root.dir, log, cancelled), handoffRequest(binding))).outcome).toBe("resumed");
    expect([log.includes("cancel"), log.slice(0, 3), log.at(-1)]).toEqual([false, ["acquire", "run", "prep-manifest"], "release"]);
  });

  it("H3 refuses a cancelled ready run and an unreadable or drifted manifest before any stage, always releasing", async () => {
    const binding = await stageReadyPreparation(root.dir);
    const refusal = async (override: Partial<HandoffSteps>) => {
      const log: string[] = [];
      const error = await handoffPreparationWith(recording(root.dir, log, override), handoffRequest(binding)).catch((caught: { code?: string }) => caught.code);
      return [error, log.filter((name) => name === "stage" || name === "release")];
    };
    expect(await refusal({ cancellationRequested: async () => true })).toEqual(["cancelled", ["release"]]);
    expect(await refusal({ readPreparationManifest: async () => ({ status: "unavailable" }) as never })).toEqual(["manifest-unavailable", ["release"]]);
    const drifted = async (...args: Parameters<HandoffSteps["readPreparationManifest"]>) => {
      const read = await prepManifests.readPreparationManifest(root.dir, ...args);
      return (read.status === "ok" ? { ...read, manifest: { ...read.manifest, preparationId: `${read.manifest.preparationId}x` } } : read) as never;
    };
    expect(await refusal({ readPreparationManifest: drifted })).toEqual(["manifest-drift", ["release"]]);
    expect(await refusal({ readRun: async () => ({ status: "absent" }) as never })).toEqual(["not-handoff-ready", ["release"]]);
  });
});

/**
 * Memory steps for one staged preparation: its run leaf and key and manifest captured once
 * from disk; run reads and the two appends through the run store's own bodies over that leaf;
 * Milestone A staging stood in by an in-memory manifest whose digest is its canonical digest.
 */
async function memoryHandoff(dir: string, binding: PreparationRunBinding, log: string[]): Promise<{ steps: HandoffSteps; leaf: { text: string } }> {
  const leafRead = await prepRuns.diskPreparationRunLeafReads(dir).readRunLeaf(binding, MAX_PREPARATION_RUN_BYTES);
  if (leafRead.kind !== "ok") throw new Error("the staged run did not read back");
  const leaf = { text: leafRead.body }, key = await readPreparationKey(dir);
  const manifest = await prepManifests.readPreparationManifest(dir, binding.workspaceId, binding.preparationId);
  const leaves = { readRunLeaf: async () => ({ kind: "ok" as const, body: leaf.text }), readKey: async () => key };
  const writes = { ...leaves, readRun: (b: PreparationRunBinding) => prepRuns.readPreparationRunFrom(leaves, b),
    readEvidence: async () => { throw new Error("no evidence read is expected"); },
    publishGenesis: async () => { throw new Error("no genesis is expected"); },
    replaceRun: async (_b: PreparationRunBinding, serialized: string) => { log.push("replace"); leaf.text = serialized; } };
  const staged = new Map<string, unknown>();
  const steps: HandoffSteps = {
    lock: { acquire: async () => { log.push("acquire"); }, release: async () => { log.push("release"); } },
    readRun: (b) => prepRuns.readPreparationRunFrom(leaves, b),
    cancellationRequested: async () => false,
    readPreparationManifest: async () => manifest,
    readOperationManifest: async (_ws, bundleId) => (staged.has(bundleId) ? { status: "ok", manifest: staged.get(bundleId) } : { status: "absent" }) as never,
    readOperationKey: async () => ({ status: "ok", keyEpochId: "memory" }) as never,
    readOperationRun: async () => ({ status: "ok", run: {} }) as never,
    stage: async (request) => {
      const memoryManifest = { bundleId: request.reservedIds!.bundleId, runId: request.reservedIds!.runId, workspaceId: binding.workspaceId };
      log.push(request.dryRun ? "dry-run" : "stage");
      if (!request.dryRun) staged.set(memoryManifest.bundleId, memoryManifest);
      return { manifest: memoryManifest, manifestDigest: canonicalDigest(memoryManifest), projectedRunBudget: {}, wrote: !request.dryRun } as never;
    },
    appendStarted: (b, expected, input) => prepRuns.appendHandoffStartedTransitionWith(writes, b, expected, input),
    appendHandoff: (b, expected, input) => prepRuns.appendHandoffTransitionWith(writes, b, expected, input),
  };
  return { steps, leaf };
}

describe("the handoff over memory alone", () => {
  it("H4 a fresh handoff over memory appends authentic handoff-started and handed-off transitions, and reaches no root form", async () => {
    const binding = await stageReadyPreparation(root.dir);
    const log: string[] = [];
    const { steps, leaf } = await memoryHandoff(root.dir, binding, log);
    const roots = [vi.spyOn(prepRuns, "readPreparationRun"), vi.spyOn(prepRuns, "appendHandoffStartedTransitionLocked"), vi.spyOn(prepRuns, "appendHandoffTransitionLocked"),
      vi.spyOn(stage, "stageOperationBundleLocked"), vi.spyOn(opManifests, "readOperationManifest"), vi.spyOn(lockGate, "acquireMutationLockBlocking")];
    const result = await handoffPreparationWith(steps, handoffRequest(binding));
    const after = await prepRuns.readPreparationRunFrom({ readRunLeaf: async () => ({ kind: "ok", body: leaf.text }), readKey: () => readPreparationKey(root.dir) }, binding);
    expect([result.outcome, after.status === "ok" && after.run.state, after.status === "ok" && after.run.transitions.slice(-2).map((transition) => transition.type)])
      .toEqual(["handed-off", "handed-off", ["handoff-started", "handed-off"]]);
    expect([log, roots.map((spy) => spy.mock.calls.length)]).toEqual([["acquire", "dry-run", "replace", "stage", "replace", "release"], [0, 0, 0, 0, 0, 0]]);
    expect(((await prepRuns.readPreparationRun(root.dir, binding)) as { run: { state: string } }).run.state).toBe("handoff-ready");
  });
});

describe("the bound composition and the root form", () => {
  it("B1 the composition reaches each store's own body over its seam, with the host's lock as given", async () => {
    const seams = Object.fromEntries(["prepRuns", "cancels", "prepManifests", "opManifests", "opKey", "opRuns", "staging", "prepWrites"].map((name) => [name, { tag: name }])) as never as Parameters<typeof handoffStepsOver>[0];
    const hostLock = { acquire: async () => {}, release: async () => {} };
    const spies = [
      vi.spyOn(prepRuns, "readPreparationRunFrom").mockResolvedValue({} as never), vi.spyOn(cancellation, "preparationCancellationRequestedFrom").mockResolvedValue(false),
      vi.spyOn(prepManifests, "readPreparationManifestFrom").mockResolvedValue({} as never), vi.spyOn(opManifests, "readOperationManifestFrom").mockResolvedValue({} as never),
      vi.spyOn(keyEpoch, "readOperationKeyFrom").mockResolvedValue({} as never), vi.spyOn(opRuns, "readOperationRunFrom").mockResolvedValue({} as never),
      vi.spyOn(stage, "stageOperationBundleWith").mockResolvedValue({} as never), vi.spyOn(prepRuns, "appendHandoffStartedTransitionWith").mockResolvedValue({} as never),
      vi.spyOn(prepRuns, "appendHandoffTransitionWith").mockResolvedValue({} as never),
    ];
    const steps = handoffStepsOver(seams, hostLock);
    await Promise.all([steps.readRun({} as never), steps.cancellationRequested("ws", "r" as never), steps.readPreparationManifest("ws", "p" as never),
      steps.readOperationManifest("ws", "b" as never), steps.readOperationKey(), steps.readOperationRun({} as never), steps.stage({} as never),
      steps.appendStarted({} as never, {} as never, {} as never), steps.appendHandoff({} as never, {} as never, {} as never)]);
    expect([steps.lock, spies.map((spy) => (spy.mock.calls[0] as unknown[])[0])]).toEqual([hostLock, [
      seams.prepRuns, seams.cancels, seams.prepManifests, seams.opManifests, seams.opKey, seams.opRuns, seams.staging, seams.prepWrites, seams.prepWrites,
    ]]);
  });

  it("B2 the root form reaches every incumbent root form with the root first, taking the handoff lock", async () => {
    const binding = await stageReadyPreparation(root.dir);
    const spies = [
      vi.spyOn(lockGate, "acquireMutationLockBlocking"), vi.spyOn(prepRuns, "readPreparationRun"), vi.spyOn(cancellation, "preparationCancellationRequested"),
      vi.spyOn(prepManifests, "readPreparationManifest"), vi.spyOn(stage, "stageOperationBundleLocked"), vi.spyOn(prepRuns, "appendHandoffStartedTransitionLocked"),
      vi.spyOn(opManifests, "readOperationManifest"), vi.spyOn(keyEpoch, "readOperationKey"), vi.spyOn(opRuns, "readOperationRun"),
      vi.spyOn(prepRuns, "appendHandoffTransitionLocked"), vi.spyOn(lock, "releaseLock"),
    ];
    expect((await handoffPreparation(root.dir, handoffRequest(binding))).outcome).toBe("handed-off");
    expect(spies.every((spy) => spy.mock.calls.length > 0 && spy.mock.calls.every((call) => call[0] === root.dir))).toBe(true);
    expect(spies[0]!.mock.calls[0]).toEqual([root.dir, "handoff"]);
  });
});

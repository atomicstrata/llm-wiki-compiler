/**
 * @file test/storage/operation-record-effect-binding.test.ts
 * @description Record-effect preparation, observation and retirement as ONE
 * body each over `RecordEffectSteps`, none of which takes a project root:
 * `prepareRecordEffectWith`, `observeRecordEffectWith`, `retireRecordEffectWith`.
 *
 * HOW IT IS BUILT. One record effect is prepared on disk through the public
 * root form. Its inventory, profile, manifest, retained payloads, observation
 * and run are read there once and answered from memory steps that log every
 * call. The bodies over memory must answer what the root forms answer on disk:
 * the same reference, the same observation. Memory cases pin each refusal's
 * reads, the reuse-versus-fresh order, and retirement's lock and append. The
 * last case shows the root forms reaching every incumbent with exact arguments.
 *
 * NOT SHOWN HERE: the trust planner, the reservation leaves, staging, run
 * authentication and the confined reads themselves; the prepare-record, observe
 * and store suites show those.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as shared from "../../src/operation-bundles/adapters/shared.js";
import * as capacity from "../../src/operation-bundles/capacity.js";
import * as reservation from "../../src/operation-bundles/effect-reservation.js";
import * as lockGate from "../../src/operation-bundles/lock-gate.js";
import * as manifestStore from "../../src/operation-bundles/manifest-store.js";
import * as observe from "../../src/operation-bundles/observe.js";
import { prepareRecordEffect, prepareRecordEffectWith, type PreparedEffectRefV1 } from "../../src/operation-bundles/prepare-record.js";
import { observeRecordEffect, observeRecordEffectWith, retireRecordEffect, retireRecordEffectWith } from "../../src/operation-bundles/record-effect.js";
import type { RecordEffectSteps } from "../../src/operation-bundles/record-effect-steps.js";
import * as runStore from "../../src/operation-bundles/run-store.js";
import * as stage from "../../src/operation-bundles/stage.js";
import * as profileBlock from "../../src/profile/block.js";
import { loadProfile } from "../../src/profile/load.js";
import * as planner from "../../src/trust/planner.js";
import * as lock from "../../src/utils/lock.js";
import { SAMPLE_PROFILE, writeProfileFile } from "../fixtures/profile-fixtures.js";
import { tempRootTracker } from "../temp-roots.js";

const tracker = tempRootTracker();
afterEach(async () => { vi.restoreAllMocks(); await tracker.cleanup(); });

const PRINCIPAL = { id: "local-flow", surface: "sdk", grants: ["operation-bundle.prepare"] } as never;

/** One record effect prepared on disk through the root form, and everything the bodies read, captured there once. */
async function prepared() {
  const root = await tracker.create("operation-record-", { real: true });
  await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
  await writeProfileFile(root, SAMPLE_PROFILE);
  const intent = {
    schema: "llmwiki-record-intent-v1", workspaceId: "demo", effectId: "note-1", profileDigest: `sha256:${(await loadProfile(root)).digest}`,
    target: { entityType: "notes", slug: "one" }, precondition: { kind: "absent" }, proposedBody: "---\ntitle: Synthetic note\n---\nProposed only.\n",
    origin: { provider: "llmflow", runId: "run", occurrenceId: "work-1", proposalDigest: `sha256:${"a".repeat(64)}` },
  };
  const ref = await prepareRecordEffect(root, PRINCIPAL, intent);
  const manifest = await manifestStore.readOperationManifest(root, ref.workspaceId, ref.bundleId as never);
  if (manifest.status !== "ok") throw new Error("prepared manifest unreadable");
  const refs = manifest.manifest.preparationEvidence.map((item) => item.payloadRef!);
  const payloads = new Map(await Promise.all(refs.map(async (payloadRef) => [payloadRef, await shared.readBundlePayload(root, ref.workspaceId, ref.bundleId as never, payloadRef)] as const)));
  const observation = await observe.observeOperationBundle(root, ref.manifestDigest);
  if (observation.status !== "observed") throw new Error("prepared effect unobserved");
  const run = await runStore.readOperationRun(root, observation.binding);
  return { root, intent, ref, manifest, payloads, observation, run, inventory: await capacity.scanOperationInventory(root), profile: await profileBlock.loadNonDefaultProfile(root) };
}
type Prepared = Awaited<ReturnType<typeof prepared>>;

/** What the memory steps answer. */
interface Answers {
  taken: boolean; inventory: Prepared["inventory"]; observation: observe.OperationBundleObservationV1; profile: Prepared["profile"];
  page: shared.LeafDigest; plan: object; staged: object; manifest: Prepared["manifest"]; run: Prepared["run"];
}

/** The captured project's answers: what every case starts from before its own overrides. */
function capturedAnswers(seed: Prepared): Answers {
  return {
    taken: true, inventory: seed.inventory, observation: seed.observation, profile: seed.profile, page: { kind: "absent" },
    plan: { decision: "allow", planned: [{}] }, staged: { manifest: seed.manifest.status === "ok" ? seed.manifest.manifest : null },
    manifest: seed.manifest, run: seed.run,
  };
}

/** Memory record-effect steps answering the captured project, with a case's `overrides` laid over it; each call logged. */
function memorySteps(seed: Prepared, log: string[], overrides: Partial<Answers> = {}): RecordEffectSteps {
  const answers = { ...capturedAnswers(seed), ...overrides };
  const at = <T>(name: string, value: T) => async () => { log.push(name); return value; };
  return {
    lock: { acquire: at("acquire", answers.taken), release: at("release", undefined) },
    scanInventory: at("inventory", answers.inventory),
    observe: at("observe", answers.observation),
    loadProfile: at("profile", answers.profile),
    readPageDigest: at("page", answers.page),
    readEntityLeaf: at("leaf", { kind: "absent" } as never),
    planPage: at("plan", answers.plan as never),
    reserve: at("reserve", { bundleId: seed.ref.bundleId, runId: seed.ref.operationRunId, createdAt: "2026-07-19T00:00:00.000Z" } as never),
    stage: at("stage", answers.staged as never),
    readManifest: at("manifest", answers.manifest),
    readPayload: async (_ws, _bundle, payloadRef) => { log.push("payload"); return seed.payloads.get(payloadRef) ?? { kind: "absent" }; },
    readRun: at("run", answers.run),
    appendTransition: async (_binding, _expected, input) => { log.push(`append ${input.type}`); return {} as never; },
  };
}

/** Prepare over memory: the reference or the refusal, and the log. */
async function prepareOver(seed: Prepared, answers: Partial<Answers> = {}, intent: object = seed.intent): Promise<[PreparedEffectRefV1 | string, string[]]> {
  const log: string[] = [];
  const outcome = await prepareRecordEffectWith(memorySteps(seed, log, answers), PRINCIPAL, intent).catch((error: Error) => error.message);
  return [outcome, log];
}

describe("record preparation as a root-free body", () => {
  it("P1 reuses an existing effect through its verified run, or prepares afresh in the incumbent order: both give the root form's reference", async () => {
    const seed = await prepared();
    expect(await prepareOver(seed)).toEqual([seed.ref, ["acquire", "inventory", "observe", "release"]]);
    expect(await prepareOver(seed, { inventory: { ...seed.inventory, manifests: [] } }))
      .toEqual([seed.ref, ["acquire", "inventory", "profile", "page", "plan", "reserve", "stage", "observe", "release"]]);
    expect(await prepareRecordEffect(seed.root, PRINCIPAL, seed.intent)).toEqual(seed.ref);
  });

  it("P2 refuses at each rung, asking nothing after it, and always releases the lock", async () => {
    const seed = await prepared();
    const fresh = { inventory: { ...seed.inventory, manifests: [] } };
    expect(await prepareOver(seed, {}, { ...seed.intent, proposedBody: "changed" })).toEqual(["effect-intent-conflict", ["acquire", "inventory", "release"]]);
    expect(await prepareOver(seed, { inventory: { ...seed.inventory, problems: [{}] } as never })).toEqual(["record-preparation-unavailable", ["acquire", "inventory", "release"]]);
    expect(await prepareOver(seed, { ...fresh, profile: undefined })).toEqual(["record-profile-drift", ["acquire", "inventory", "profile", "release"]]);
    expect(await prepareOver(seed, { ...fresh, page: { kind: "ok", digest: `sha256:${"c".repeat(64)}` as never } })).toEqual(["record-preimage-drift", ["acquire", "inventory", "profile", "page", "release"]]);
    expect(await prepareOver(seed, { ...fresh, plan: { decision: "deny", planned: [] } })).toEqual(["record-target-refused", ["acquire", "inventory", "profile", "page", "plan", "release"]]);
    expect(await prepareOver(seed, { observation: { status: "absent" } })).toEqual(["record-preparation-unavailable", ["acquire", "inventory", "observe", "release"]]);
  });
});

describe("record observation and retirement as root-free bodies", () => {
  it("R1 observes the exact effect as the root form does; a foreign coordinate stops after the bytes that disprove it", async () => {
    const seed = await prepared();
    const log: string[] = [];
    expect(await observeRecordEffectWith(memorySteps(seed, log), seed.ref)).toEqual(await observeRecordEffect(seed.root, seed.ref));
    expect(log).toEqual(["manifest", "payload", "payload", "observe"]);
    log.length = 0;
    expect(await observeRecordEffectWith(memorySteps(seed, log), { ...seed.ref, effectId: "foreign" })).toEqual({ status: "unavailable", detail: "record effect observation unavailable" });
    expect(log).toEqual(["manifest", "payload"]);
  });

  it("R2 retires only the preparer's never-started effect, appending superseded under the lock and re-observing", async () => {
    const seed = await prepared();
    const retire = async (answers: Partial<Answers> = {}, principal = PRINCIPAL) => {
      const log: string[] = [];
      const outcome = await retireRecordEffectWith(memorySteps(seed, log, answers), principal, seed.ref).then((o) => o.status, (error: Error) => error.message);
      return [outcome, log];
    };
    const resolve = ["manifest", "payload", "payload", "observe"];
    expect(await retire({}, { ...(PRINCIPAL as object), id: "other" } as never)).toEqual(["record-preparer-mismatch", ["acquire", ...resolve, "release"]]);
    expect(await retire()).toEqual(["observed", ["acquire", ...resolve, "run", "append superseded", ...resolve, "release"]]);
    const as = (state: string) => (seed.run.status === "ok" ? { status: "ok" as const, run: { ...seed.run.run, state } } : seed.run) as never;
    expect(await retire({ run: as("superseded") })).toEqual(["observed", ["acquire", ...resolve, "run", "release"]]);
    expect(await retire({ run: as("applying") })).toEqual(["record-retirement-refused", ["acquire", ...resolve, "run", "release"]]);
  });
});

describe("the root forms", () => {
  it("Z1 prepare and retire reach every incumbent with the root and their old arguments; the bodies over memory reach none", async () => {
    const seed = await prepared();
    const spies = [vi.spyOn(capacity, "scanOperationInventory"), vi.spyOn(observe, "observeOperationBundle"), vi.spyOn(profileBlock, "loadNonDefaultProfile"),
      vi.spyOn(shared, "readPageDigest"), vi.spyOn(planner, "planPageMutation"), vi.spyOn(reservation, "reserveRecordEffectLocked"),
      vi.spyOn(stage, "stageOperationBundleLocked"), vi.spyOn(manifestStore, "readOperationManifest"), vi.spyOn(shared, "readBundlePayload"),
      vi.spyOn(runStore, "readOperationRun"), vi.spyOn(runStore, "appendOperationTransitionLocked"), vi.spyOn(lockGate, "acquireMutationLock"), vi.spyOn(lock, "releaseLock")];
    await prepareRecordEffectWith(memorySteps(seed, [], { inventory: { ...seed.inventory, manifests: [] } }), PRINCIPAL, seed.intent);
    await retireRecordEffectWith(memorySteps(seed, []), PRINCIPAL, seed.ref);
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual(Array(13).fill(0));
    const second = { ...seed.intent, effectId: "note-2", target: { entityType: "notes", slug: "two" } };
    await prepareRecordEffect(seed.root, PRINCIPAL, second);
    await retireRecordEffect(seed.root, PRINCIPAL, seed.ref);
    const firsts = spies.map((spy) => spy.mock.calls[0]?.[0]);
    expect(firsts).toEqual([...Array(4).fill(seed.root), expect.objectContaining({ root: seed.root, body: second.proposedBody }), ...Array(8).fill(seed.root)]);
    expect([spies[11]!.mock.calls[0], spies[12]!.mock.calls[0]]).toEqual([[seed.root, "ordinary"], [seed.root]]);
    expect(spies[10]!.mock.calls.map((call: readonly unknown[]) => (call[3] as { type: string }).type)).toContain("superseded");
  });
});

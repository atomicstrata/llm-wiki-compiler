/**
 * @file test/storage/stage-materialization-binding.test.ts
 * @description The operation-bundle stage materialization classifier as ONE
 * body over its one collaborator, `inspectStageMaterializationWith`, driven
 * DIRECTLY with no project directory: the identity refusals before any read,
 * the inspection order and caps, the run's identity rules, and the
 * classification it returns. The staging journey suites drove this body only
 * through the root form, or with materialization stubbed.
 *
 * HOW IT IS BUILT. A scripted `inspectCandidate` answers each candidate leaf
 * from a per-kind answer and logs the leaf, cap, conflict message and mode it
 * was asked with. The root form is shown reaching the incumbent
 * `inspectDurableCandidate` with each leaf's confined path and owned parent.
 *
 * NOT SHOWN HERE: the durable candidate inspection itself (final, ready and
 * scratch leaves, confinement, byte deltas on disk); the durable-candidate and
 * staging suites show those. The doubles are not a hosted store.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import type { OperationInventory } from "../../src/operation-bundles/capacity.js";
import { MAX_MANIFEST_BYTES, MAX_PAYLOAD_BYTES, MAX_RUN_BYTES } from "../../src/operation-bundles/constants.js";
import * as durableCandidate from "../../src/operation-bundles/durable-candidate.js";
import { mintBundleId, mintOperationRunId } from "../../src/operation-bundles/ids.js";
import { operationPaths } from "../../src/operation-bundles/paths.js";
import {
  inspectStageMaterialization, inspectStageMaterializationWith, type StageCandidateLeaf, type StageMaterializationReads,
} from "../../src/operation-bundles/stage-materialization.js";
import type { OperationBundleManifest } from "../../src/operation-bundles/types.js";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";

afterEach(() => { vi.restoreAllMocks(); });

const [PAYLOAD_A, PAYLOAD_B] = ["a".repeat(64), "b".repeat(64)];
const MANIFEST = { bundleId: mintBundleId(), runId: mintOperationRunId(), workspaceId: "research" } as unknown as OperationBundleManifest;
const MANIFEST_BYTES = canonicalBytes(MANIFEST);
const RUN_BYTES = Buffer.from("run");
/** Payloads deliberately given out of digest order: inspection must sort them. */
const PAYLOADS = new Map([[PAYLOAD_B, Buffer.from("bb")], [PAYLOAD_A, Buffer.from("a")]]);

type Answer = Awaited<ReturnType<StageMaterializationReads["inspectCandidate"]>>;
const FRESH = (bytes: number): Answer => ({ authoritative: false, publicationRequired: true, physicalByteDelta: bytes });
const SETTLED: Answer = { authoritative: true, publicationRequired: false, physicalByteDelta: 0 };

/** An inventory holding exactly what a case names. */
function inventoryOf(over: { manifests?: OperationBundleManifest[]; runIds?: string[]; complete?: boolean } = {}): OperationInventory {
  return {
    manifests: over.manifests ?? [], runIds: new Set(over.runIds ?? []),
    completeBundleIds: new Set(over.complete ? [MANIFEST.bundleId] : []),
  } as unknown as OperationInventory;
}

/** Reads answering every leaf of `kind` with `answers[kind]`, each call logged as `<kind> <digest?> <cap> <conflict> <mode>`. */
function readsOf(log: string[], answers: Partial<Record<StageCandidateLeaf["kind"], Answer>>): StageMaterializationReads {
  return {
    inspectCandidate: async (leaf, expected, maxBytes, conflict, mode) => {
      log.push([leaf.kind, leaf.kind === "payload" ? leaf.digest.slice(0, 1) : "-", expected.byteLength, maxBytes, conflict, mode ?? "-"].join(" "));
      return answers[leaf.kind] ?? FRESH(expected.byteLength);
    },
  };
}

/** A request staging the run with the bundle; {@link withoutRun} drops the run bytes explicitly. */
const request = (inventory: OperationInventory) =>
  ({ manifest: MANIFEST, manifestBytes: MANIFEST_BYTES, payloads: PAYLOADS, inventory, runBytes: RUN_BYTES as Buffer | undefined });
/** The same request with NO run bytes (an explicit `undefined`, not a defaulted argument). */
const withoutRun = (inventory: OperationInventory) => ({ ...request(inventory), runBytes: undefined });

describe("stage materialization, driven directly over its one collaborator", () => {
  it("M1 inspects payloads in digest order, then the manifest, then the run, each under its own cap, conflict and mode", async () => {
    const log: string[] = [];
    const result = await inspectStageMaterializationWith(readsOf(log, {}), request(inventoryOf()));
    expect(log).toEqual([
      `payload a 1 ${MAX_PAYLOAD_BYTES} operation bundle payload identity conflict -`,
      `payload b 2 ${MAX_PAYLOAD_BYTES} operation bundle payload identity conflict -`,
      `manifest - ${MANIFEST_BYTES.byteLength} ${MAX_MANIFEST_BYTES} operation bundle manifest identity conflict ${0o600}`,
      `run - ${RUN_BYTES.byteLength} ${MAX_RUN_BYTES} operation run identity conflict ${0o600}`,
    ]);
    expect(result).toEqual({
      complete: false, missingManifest: true, missingRun: true, missingPayloads: new Set([PAYLOAD_A, PAYLOAD_B]),
      physicalActiveByteDelta: 3 + MANIFEST_BYTES.byteLength, settled: false,
    });
  });

  it("M2 is settled only when nothing needs publication, and reports the inventory's completeness", async () => {
    const all = { payload: SETTLED, manifest: SETTLED, run: SETTLED };
    expect(await inspectStageMaterializationWith(readsOf([], all), request(inventoryOf({ complete: true })))).toEqual({
      complete: true, missingManifest: false, missingRun: false, missingPayloads: new Set(), physicalActiveByteDelta: 0, settled: true,
    });
    expect((await inspectStageMaterializationWith(readsOf([], { ...all, run: FRESH(3) }), request(inventoryOf()))).settled).toBe(false);
  });

  it("M3 refuses a same-id bundle with other bytes, and an unsafe workspace, before any read", async () => {
    const log: string[] = [];
    const other = { ...MANIFEST, workspaceId: "elsewhere" } as unknown as OperationBundleManifest;
    await expect(inspectStageMaterializationWith(readsOf(log, {}), request(inventoryOf({ manifests: [other] }))))
      .rejects.toThrow("operation bundle identity conflict");
    const unsafe = { ...MANIFEST, workspaceId: "../out" } as unknown as OperationBundleManifest;
    await expect(inspectStageMaterializationWith(readsOf(log, {}), { ...request(inventoryOf()), manifest: unsafe, manifestBytes: canonicalBytes(unsafe) }))
      .rejects.toThrow();
    expect(log).toEqual([]);
    expect((await inspectStageMaterializationWith(readsOf([], {}), request(inventoryOf({ manifests: [MANIFEST] })))).missingManifest).toBe(true);
  });

  it("M4 applies the run identity rules: inventoried without run bytes refuses before any run read; with them, only an authoritative run passes", async () => {
    const kinds = (log: string[]) => log.map((call) => call.split(" ")[0]);
    const log: string[] = [];
    await expect(inspectStageMaterializationWith(readsOf(log, {}), withoutRun(inventoryOf({ runIds: [MANIFEST.runId] }))))
      .rejects.toThrow("operation run identity conflict");
    expect(kinds(log)).toEqual(["payload", "payload", "manifest"]);
    const unstaged: string[] = [];
    expect((await inspectStageMaterializationWith(readsOf(unstaged, {}), withoutRun(inventoryOf()))).missingRun).toBe(true);
    expect(kinds(unstaged)).toEqual(["payload", "payload", "manifest"]);
    const stale: string[] = [];
    await expect(inspectStageMaterializationWith(readsOf(stale, {}), request(inventoryOf({ runIds: [MANIFEST.runId] }))))
      .rejects.toThrow("operation run identity conflict");
    expect(kinds(stale)).toEqual(["payload", "payload", "manifest", "run"]);
    expect((await inspectStageMaterializationWith(readsOf([], { run: SETTLED }), request(inventoryOf({ runIds: [MANIFEST.runId] })))).missingRun).toBe(false);
  });

  it("M5 the bound route reaches no durable inspection, while the root form reaches it with each leaf's confined path and owned parent", async () => {
    const inspect = vi.spyOn(durableCandidate, "inspectDurableCandidate").mockResolvedValue(SETTLED);
    await inspectStageMaterializationWith(readsOf([], {}), request(inventoryOf()));
    expect(inspect.mock.calls).toEqual([]);
    const root = "/memory/project";
    const paths = operationPaths(root, MANIFEST.workspaceId);
    await inspectStageMaterialization(root, MANIFEST, MANIFEST_BYTES, PAYLOADS, inventoryOf(), RUN_BYTES);
    expect(inspect.mock.calls).toEqual([
      [root, paths.payloadFile(MANIFEST.bundleId, PAYLOAD_A), paths.payloadsRoot(MANIFEST.bundleId), PAYLOADS.get(PAYLOAD_A), MAX_PAYLOAD_BYTES, "operation bundle payload identity conflict", undefined],
      [root, paths.payloadFile(MANIFEST.bundleId, PAYLOAD_B), paths.payloadsRoot(MANIFEST.bundleId), PAYLOADS.get(PAYLOAD_B), MAX_PAYLOAD_BYTES, "operation bundle payload identity conflict", undefined],
      [root, paths.manifestFile(MANIFEST.bundleId), paths.bundleRoot(MANIFEST.bundleId), MANIFEST_BYTES, MAX_MANIFEST_BYTES, "operation bundle manifest identity conflict", 0o600],
      [root, paths.runFile(MANIFEST.runId), paths.runsRoot, RUN_BYTES, MAX_RUN_BYTES, "operation run identity conflict", 0o600],
    ]);
  });
});

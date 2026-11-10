/**
 * @file test/storage/operation-write-journey.test.ts
 * @description ONE real-disk operation-bundle write journey through the shipped
 * root entry points, each of which now reaches its root-free body over the
 * local-disk collaborators: stage (payload, manifest, genesis) with FIXED ids and
 * clock, an exact replay, an apply that parks the run, a recovery bundle staged,
 * applied and used to settle the original as `recovered`.
 *
 * INDEPENDENT EXPECTATIONS. Paths are spelled out from the documented store layout
 * and digests are computed here with `node:crypto` over the bytes read back from
 * disk, not taken from the code under test; the authenticated run reads are the
 * shipped reader. Root-versus-bound equality is wiring evidence and lives in the
 * binding suites, not here.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { approveAndApplyOperationBundleLocked } from "../../src/operation-bundles/executor.js";
import type { BundleId, OperationRunId } from "../../src/operation-bundles/ids.js";
import { readOperationKey } from "../../src/operation-bundles/key-epoch.js";
import { planRecoveryBundleLocked, settleOriginalFromRecoveryLocked } from "../../src/operation-bundles/recovery-plan.js";
import { readOperationRun } from "../../src/operation-bundles/run-store.js";
import { stageOperationBundleLocked, type OperationBundleDraft, type StageOperationBundleRequest } from "../../src/operation-bundles/stage.js";
import type { OperationDigest } from "../../src/operation-bundles/types.js";
import {
  approveRequest, buildRuntime, OPERATOR_PRINCIPAL, outageAtApplyAuthority, sourceRecoveryPlanner, WORKSPACE, type StagedBundle,
} from "../operation-bundles/executor-fixtures.js";

const AT = "2026-07-19T00:00:00.000Z";
const BUNDLE_ID = "bnd_01J8Z0000000000000000000AB" as BundleId;
const RUN_ID = "opr_01J8Z0000000000000000000CD" as OperationRunId;
const DIGEST = `sha256:${"0".repeat(64)}` as OperationDigest;
const BYTES = Buffer.from("journey retained source\n");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const PAYLOAD = sha256(BYTES);

let root = "";
beforeAll(async () => { root = await mkdtemp(path.join(os.tmpdir(), "op-write-journey-")); });
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/** The one fixed-id, fixed-clock source-retain request this journey stages. */
function request(): StageOperationBundleRequest {
  const draft: OperationBundleDraft = {
    workspaceId: WORKSPACE, createdBy: "planner", knowledgeAuthority: { id: "k", digest: DIGEST },
    operationsAuthority: { packId: "p", packDigest: DIGEST, actionId: "a", actionDescriptorDigest: DIGEST },
    grantDigest: DIGEST, safetyFloorDigest: DIGEST, inputs: [], preparationEvidence: [], bounds: [],
    completeness: { attempted: 0, completed: 0, skipped: 0, failed: 0, requiredMissing: 0, optionalMissing: 0, rationaleDigest: DIGEST },
    reconciliations: [], planningWarnings: [],
    mutations: [{
      kind: "source-retain", operation: "create", target: { digest: PAYLOAD }, payloadRef: PAYLOAD, dependsOn: [], reconciliationRefs: [],
      precondition: { kind: "absent-or-same", digest: `sha256:${PAYLOAD}` as OperationDigest, byteCount: BYTES.length },
      postcondition: { digest: `sha256:${PAYLOAD}` as OperationDigest, byteCount: BYTES.length },
    }],
    run: { actor: { id: "planner", surface: "sdk", grants: [] }, declaredCompensatorIndexes: [], controlTransitionAllowance: 32 },
  };
  return { draft, payloads: new Map([[PAYLOAD, BYTES]]), clock: { now: () => new Date(AT) }, idsForTest: { bundleId: BUNDLE_ID, runId: RUN_ID } };
}

/** The authenticated run of one bundle, read through the shipped reader under the current key. */
async function runOf(staged: StagedBundle, runId: OperationRunId) {
  const key = await readOperationKey(root);
  if (key.status !== "ok") throw new Error("key unreadable");
  const read = await readOperationRun(root, { runId, bundleId: staged.bundleId, workspaceId: WORKSPACE, manifestDigest: staged.manifestDigest as `sha256:${string}`, keyEpochId: key.keyEpochId });
  if (read.status !== "ok") throw new Error(`run ${read.status}`);
  return read.run;
}

describe("one operation-bundle write journey on real disk", () => {
  const store = () => path.join(root, ".llmwiki", "workspaces", WORKSPACE);
  let staged: StagedBundle;

  it("J1 stages payload, canonical manifest and genesis at the documented paths with the fixed ids and clock, then replays without writing", async () => {
    const result = await stageOperationBundleLocked(root, request());
    const manifestBytes = await readFile(path.join(store(), "bundles", BUNDLE_ID, "manifest.json"));
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as { bundleId: string; runId: string; createdAt: string };
    expect([result.wrote, manifest.bundleId, manifest.runId, manifest.createdAt]).toEqual([true, BUNDLE_ID, RUN_ID, AT]);
    expect(result.manifestDigest).toBe(`sha256:${sha256(manifestBytes)}`);
    expect(await readFile(path.join(store(), "bundles", BUNDLE_ID, "payloads", PAYLOAD))).toEqual(BYTES);
    staged = { bundleId: BUNDLE_ID, manifestDigest: result.manifestDigest, workspaceId: WORKSPACE };
    const genesis = await runOf(staged, RUN_ID);
    expect([genesis.state, genesis.runId, genesis.transitions.at(-1)?.at]).toEqual(["awaiting-approval", RUN_ID, AT]);
    const runBytes = await readFile(path.join(store(), "runs", `${RUN_ID}.json`));
    expect((await stageOperationBundleLocked(root, request())).wrote).toBe(false);
    expect(await readFile(path.join(store(), "runs", `${RUN_ID}.json`))).toEqual(runBytes);
  });

  it("J2 parks the run through an authenticated append when apply-time authority is unavailable", async () => {
    await approveAndApplyOperationBundleLocked(root, approveRequest(staged, buildRuntime({ authority: outageAtApplyAuthority() })));
    expect((await runOf(staged, RUN_ID)).state).toBe("recovery-required");
  });

  it("J3 stages and applies a recovery bundle, retains its source, and settles the original as recovered", async () => {
    const plan = await planRecoveryBundleLocked(root, {
      workspaceId: WORKSPACE, originalBundleId: BUNDLE_ID, originalManifestDigest: staged.manifestDigest, principal: OPERATOR_PRINCIPAL, actionInput: {},
    }, sourceRecoveryPlanner(Buffer.from("journey recovery payload\n")));
    const recovery: StagedBundle = { bundleId: plan.manifest.bundleId, manifestDigest: plan.manifestDigest, workspaceId: WORKSPACE };
    expect((await approveAndApplyOperationBundleLocked(root, approveRequest(recovery, buildRuntime()))).state).toBe("succeeded");
    const recoveredDigest = sha256(Buffer.from("journey recovery payload\n"));
    expect(await readFile(path.join(store(), "sources", recoveredDigest), "utf8")).toBe("journey recovery payload\n");
    const settled = await settleOriginalFromRecoveryLocked(root, {
      workspaceId: WORKSPACE, originalBundleId: BUNDLE_ID, originalManifestDigest: staged.manifestDigest,
      recoveryBundleId: recovery.bundleId, recoveryManifestDigest: recovery.manifestDigest, principal: OPERATOR_PRINCIPAL, at: "2026-07-19T01:00:00.000Z",
    });
    expect(settled.state).toBe("recovered");
    const original = await runOf(staged, RUN_ID);
    expect([original.state, original.transitions.at(-1)?.payload]).toMatchObject(["recovered", { kind: "recovery", bundleId: recovery.bundleId, terminalState: "succeeded" }]);
  });
});

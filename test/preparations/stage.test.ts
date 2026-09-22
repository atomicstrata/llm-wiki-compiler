/**
 * @file test/preparations/stage.test.ts
 * @description Locked staging transaction contract: the happy path materializes
 * declared prepared-input evidence and publishes the manifest and run in the
 * required durable order; the run authenticates and reads back as `planned`; dry
 * run and an exact fixed-id replay are pure; evidence enters ONLY by
 * materializing a declared prepared input (there is no caller-buffer bypass);
 * a stale caller-file input parks without writing a byte; and a revised plan
 * that supersedes a prior preparation becomes a distinct manifest/run carrying
 * explicit supersession history without rewriting the prior (PO-INV-02).
 */

import { access, mkdir, readdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { readPreparationManifest } from "../../src/preparations/manifest-store.js";
import { readPreparationEvidence } from "../../src/preparations/evidence-store.js";
import { readPreparationRun } from "../../src/preparations/run-store.js";
import { preparationManifestDigest } from "../../src/preparations/manifest-parse.js";
import { readPreparationKey } from "../../src/preparations/key-epoch.js";
import { preparationPaths } from "../../src/preparations/paths.js";
import { assertStageCapacity, StageCapacityError } from "../../src/preparations/capacity.js";
import { MAX_PREPARED_INPUTS_PER_RUN } from "../../src/preparations/constants.js";
import { stagePreparationLocked } from "../../src/preparations/stage.js";
import type { PreparationInitialInputV1 } from "../../src/preparations/initial-inputs.js";
import { fixturePlan, seedDigest, stageRequest } from "./store-fixture.js";

const root = useTempRoot();

/** Read the authenticated run for a staged preparation result. */
async function readStagedRun(dir: string, staged: Extract<Awaited<ReturnType<typeof stagePreparationLocked>>, { status: "staged" }>) {
  const key = await readPreparationKey(dir);
  if (key.status !== "ok") throw new Error("key missing");
  return readPreparationRun(dir, {
    runId: staged.manifest.runId, preparationId: staged.manifest.preparationId, workspaceId: staged.manifest.workspaceId,
    manifestDigest: preparationManifestDigest(staged.manifest), keyEpochId: key.keyEpochId,
  });
}

describe("stagePreparationLocked", () => {
  it("publishes evidence, manifest, and a planned genesis run", async () => {
    const staged = await stagePreparationLocked(root.dir, stageRequest());
    expect(staged.status).toBe("staged");
    if (staged.status !== "staged") return;
    expect(staged.wrote).toBe(true);
    const manifest = await readPreparationManifest(root.dir, staged.manifest.workspaceId, staged.manifest.preparationId);
    expect(manifest.status).toBe("ok");
    const evidence = await readPreparationEvidence(root.dir, { workspaceId: staged.manifest.workspaceId, preparationId: staged.manifest.preparationId }, seedDigest());
    expect(evidence.status).toBe("ok");
    const run = await readStagedRun(root.dir, staged);
    expect(run.status === "ok" && run.run.state).toBe("planned");
  });

  it("revises a plan into a new manifest carrying supersession history, leaving the prior immutable (PO-INV-02)", async () => {
    const first = await stagePreparationLocked(root.dir, stageRequest());
    if (first.status !== "staged") throw new Error("first edition not staged");
    expect(first.manifest.plan.supersedesPreparationId).toBeUndefined();
    // The revision records explicit supersession history in its own immutable plan.
    const revised = fixturePlan((plan) => { plan.supersedesPreparationId = first.manifest.preparationId; });
    const second = await stagePreparationLocked(root.dir, stageRequest(revised));
    if (second.status !== "staged") throw new Error("revised edition not staged");
    expect(second.manifest.preparationId).not.toBe(first.manifest.preparationId);
    expect(second.manifest.plan.supersedesPreparationId).toBe(first.manifest.preparationId);
    // The prior manifest is neither rewritten nor deleted: it still binds its own plan.
    const prior = await readPreparationManifest(root.dir, first.manifest.workspaceId, first.manifest.preparationId);
    expect(prior.status === "ok" && prior.manifest.plan.supersedesPreparationId).toBeUndefined();
  });

  it("treats an exact fixed-id replay as an idempotent no-op", async () => {
    const clock = { now: () => new Date("2026-07-20T00:00:00.000Z") };
    const first = await stagePreparationLocked(root.dir, stageRequest(fixturePlan(), { clock }));
    if (first.status !== "staged") throw new Error("not staged");
    const replay = await stagePreparationLocked(root.dir, stageRequest(first.manifest.plan, {
      clock, idsForTest: { preparationId: first.manifest.preparationId, runId: first.manifest.runId },
    }));
    expect(replay.status === "staged" && replay.wrote).toBe(false);
  });

  it("keeps a dry run pure once a key epoch exists", async () => {
    await stagePreparationLocked(root.dir, stageRequest());
    const dry = await stagePreparationLocked(root.dir, stageRequest(fixturePlan(), { dryRun: true }));
    expect(dry.status === "staged" && dry.wrote).toBe(false);
    if (dry.status !== "staged") return;
    await expect(access(preparationPaths(root.dir, "research").manifestFile(dry.manifest.preparationId))).rejects.toThrow();
  });

  it("admits evidence only by materializing a declared prepared input", async () => {
    const staged = await stagePreparationLocked(root.dir, stageRequest());
    if (staged.status !== "staged") throw new Error("not staged");
    // The seed evidence exists ONLY because the declared structured input was
    // materialized; the request carries no channel to inject raw evidence bytes.
    const location = { workspaceId: staged.manifest.workspaceId, preparationId: staged.manifest.preparationId };
    expect((await readPreparationEvidence(root.dir, location, seedDigest())).status).toBe("ok");
    expect(staged.manifest.initialEvidence.map((ref) => ref.digest)).toEqual([`sha256:${seedDigest()}`]);
  });

  it("parks on a stale caller-file initial input without writing a byte", async () => {
    await mkdir(`${root.dir}/sources`, { recursive: true });
    const stale: PreparationInitialInputV1 = {
      kind: "caller-file",
      source: {
        sourceRoot: `${root.dir}/sources`, sourceLeaf: `${root.dir}/sources/missing.txt`, sourceIdentity: "sources/missing.txt",
        provenanceLabel: "caller-file", mediaType: "text/plain", sensitivity: "ordinary",
        retention: "until-handoff", evidenceKind: "prepared-input",
      },
    };
    const parked = await stagePreparationLocked(root.dir, stageRequest(fixturePlan(), { initialInputs: [stale] }));
    expect(parked).toEqual({ status: "parked", reason: "initial-input-absent" });
    await expect(access(preparationPaths(root.dir, "research").preparationsRoot)).rejects.toThrow();
  });

  it("fails closed when the prepared-inputs projection exceeds the per-run ceiling (PO-INV-10)", () => {
    const projection = {
      newPreparations: 1, activeNonterminalRuns: 0, workspacePreparations: 0,
      preparedInputs: MAX_PREPARED_INPUTS_PER_RUN + 1, manifestBytes: 0, runBytes: 0,
      evidenceObjectBytes: 0, activeBytes: 0,
    };
    expect(() => assertStageCapacity(projection)).toThrow(StageCapacityError);
  });

  it("parks a fresh-project dry run instead of throwing", async () => {
    const dry = await stagePreparationLocked(root.dir, stageRequest(fixturePlan(), { dryRun: true }));
    expect(dry).toEqual({ status: "parked", reason: "preparation-integrity-key-missing" });
  });

  it("refuses a redirected namespace before writes and stages after repair", async () => {
    const decoy = path.join(root.dir, "decoy");
    await mkdir(decoy);
    const privateRoot = path.join(root.dir, ".llmwiki");
    await symlink(decoy, privateRoot);
    await expect(stagePreparationLocked(root.dir, stageRequest()))
      .rejects.toThrow(/lifecycle-storage/u);
    expect(await readdir(decoy, { recursive: true })).toEqual([]);
    await rm(privateRoot);
    const staged = await stagePreparationLocked(root.dir, stageRequest());
    expect(staged.status === "staged" && staged.wrote).toBe(true);
  });
});

/**
 * @file test/operations-packs/pack-relation-drive.test.ts
 * @description G4b end to end: a pack action whose intent terminal drafts a
 * RELATION reaches a Milestone A handoff, and applying that bundle writes the
 * relation into the store under EXACTLY the record id the manifest promised.
 * The id equality is the slice's whole point: `postcondition.recordId` used to
 * be the reason relation-upsert was refused ("minted by the store at apply
 * time"), and the promised-id thread is what turns the attestation into a fact
 * — so these cases assert the store's id AGAINST the manifest's, never merely
 * that some relation exists.
 */

import { afterEach, describe, expect, it } from "vitest";
import { scanOperationInventory } from "../../src/operation-bundles/capacity.js";
import { readOperationKey } from "../../src/operation-bundles/key-epoch.js";
import { operationManifestDigest } from "../../src/operation-bundles/manifest-parse.js";
import { readOperationRun } from "../../src/operation-bundles/run-store.js";
import { appendRelation } from "../../src/relations/store.js";
import type { EntityId } from "../../src/profile/types.js";
import { createCliOperationRuntime } from "../../src/operation-bundles/runtime-factory.js";
import { applyProductBundle } from "../../src/products/apply.js";
import { readRelationRecords } from "../../src/relations/store-read.js";
import type { ProfilePack } from "../../src/profile/types.js";
import { writeProfileFile } from "../fixtures/profile-fixtures.js";
import {
  compileCitesRelationAction, driveStagedRun, resultReason, stageCompiledAction,
  stagedRunTracker, type StagedPackRunV1,
} from "./runtime-fixture.js";

const tracker = stagedRunTracker();
afterEach(() => tracker.cleanupAll());

/** The profile the relation is validated against at apply: papers cite papers. */
const PROFILE: ProfilePack = {
  schemaVersion: 1, profileId: "g4b-test",
  entities: { papers: { directory: "wiki/papers" } },
  relations: { cites: { from: ["papers"], to: ["papers"], direction: "directed" } },
};

const INPUT = { relationType: "cites", from: "papers/alpha", to: "papers/beta" } as const;

/** Stage the relation action with the citing profile installed beside it. */
async function stagedRelationRun(): Promise<StagedPackRunV1> {
  const run = tracker.add(await stageCompiledAction(await compileCitesRelationAction(INPUT)));
  await writeProfileFile(run.root, PROFILE);
  return run;
}

/** Apply one handed-off bundle as a granted local operator. */
async function applyBundle(root: string, bundle: string) {
  return applyProductBundle({
    root, principal: { id: "g4b-test", surface: "cli", grants: ["operation-bundle.approve"] },
    runtime: createCliOperationRuntime(),
  }, { bundle });
}

/** The relation mutation's promised postcondition, read off the durable manifest. */
async function promisedPostcondition(root: string): Promise<{ recordId: string; digest: string }> {
  const manifest = (await scanOperationInventory(root)).manifests[0]!;
  const relation = manifest.mutations.find((mutation) => mutation.kind === "relation")!;
  return relation.postcondition as { recordId: string; digest: string };
}

describe("G4b: a relation proposal applies under its promised record id", () => {
  it("hands off, applies, and the store carries EXACTLY the manifest's id", async () => {
    const run = await stagedRelationRun();
    const result = await driveStagedRun(run);
    expect(result.status, resultReason(result)).toBe("handed-off");
    if (result.status !== "handed-off") throw new Error("unreachable");
    const promised = (await promisedPostcondition(run.root)).recordId;
    expect(promised).toMatch(/^rel_[0-9a-f]{16}$/);
    const outcome = await applyBundle(run.root, result.bundleManifestDigest);
    expect(outcome.status, JSON.stringify(outcome)).toBe("applied");
    const { records } = await readRelationRecords(run.root);
    expect(records).toHaveLength(1);
    expect(records[0]!.ref.id).toBe(promised);
    expect(records[0]!.ref.type).toBe("cites");
    // The attested digest IS the persisted content hash — one quantity, the
    // store's own primitive on both sides.
    const attested = (await promisedPostcondition(run.root)).digest;
    expect(`sha256:${records[0]!.ref.contentHash}`).toBe(attested);
  });

  it("re-applying is idempotent: the postcondition holds and nothing duplicates", async () => {
    const run = await stagedRelationRun();
    const result = await driveStagedRun(run);
    if (result.status !== "handed-off") throw new Error(resultReason(result));
    await applyBundle(run.root, result.bundleManifestDigest);
    const again = await applyBundle(run.root, result.bundleManifestDigest);
    expect(again.status, JSON.stringify(again)).toBe("applied");
    const { records } = await readRelationRecords(run.root);
    expect(records).toHaveLength(1);
    expect(records[0]!.ref.id).toBe((await promisedPostcondition(run.root)).recordId);
  });

  it("a same-content dedupe's existing id survives into the DURABLE outcome", async () => {
    // The adapter names the satisfying record; the run's PERSISTED mutation
    // outcome must carry it too — a detail dropped at the executor would leave
    // the public result attesting a recordId that exists nowhere, silently.
    const run = await stagedRelationRun();
    const result = await driveStagedRun(run);
    if (result.status !== "handed-off") throw new Error(resultReason(result));
    const existing = await appendRelation(run.root, PROFILE, {
      type: "cites", from: "papers/alpha" as EntityId, to: "papers/beta" as EntityId,
      attributes: { confidence: 1 },
    });
    const outcome = await applyBundle(run.root, result.bundleManifestDigest);
    expect(outcome.status, JSON.stringify(outcome)).toBe("applied");
    const manifest = (await scanOperationInventory(run.root)).manifests[0]!;
    const key = await readOperationKey(run.root);
    if (key.status !== "ok") throw new Error(`operation key ${key.status}`);
    const read = await readOperationRun(run.root, {
      runId: manifest.runId, bundleId: manifest.bundleId,
      manifestDigest: operationManifestDigest(manifest) as `sha256:${string}`,
      workspaceId: manifest.workspaceId, keyEpochId: key.keyEpochId,
    });
    if (read.status !== "ok") throw new Error(`operation run ${read.status}`);
    const skipped = read.run.mutationOutcomes.find((entry) => entry.status === "skipped-idempotent");
    expect(skipped?.detail).toContain(existing.id);
  });
});

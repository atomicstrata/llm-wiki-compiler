/**
 * @file test/operation-bundles/relation-recovery-detail.test.ts
 * @description G4b round-6: a same-content dedupe's satisfying record id must
 * survive CRASH RECOVERY, not only the forward path. A fault after the seam
 * wrote the bound child event but before the outcome transition leaves a
 * started mutation; recovery re-OBSERVES, and the observation now names the
 * pre-existing record that satisfies the content, so the recovery-derived
 * `skipped-idempotent` outcome carries the same observable claim boundary the
 * forward path records — never a silent skip attesting an id that exists
 * nowhere.
 */

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { approveAndApplyOperationBundleLocked } from "../../src/operation-bundles/executor.js";
import { recoverOperationRunLocked } from "../../src/operation-bundles/recovery.js";
import { relationContentHash } from "../../src/relations/digest.js";
import { appendRelation } from "../../src/relations/store.js";
import type { EntityId, ProfilePack } from "../../src/profile/types.js";
import { writeProfileFile } from "../fixtures/profile-fixtures.js";
import {
  approveRequest, buildRuntime, readStagedRun, stageRelationBundle, type StagedBundle,
} from "./executor-fixtures.js";

const PROFILE: ProfilePack = {
  schemaVersion: 1, profileId: "r6",
  entities: { papers: { directory: "wiki/papers" } },
  relations: { cites: { from: ["papers"], to: ["papers"], direction: "directed" } },
};

const INPUT = { type: "cites", from: "papers/a" as EntityId, to: "papers/b" as EntityId };

let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "rel-recover-"));
  await writeProfileFile(root, PROFILE);
});
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/** The persisted run's mutation outcomes, read off disk. */
async function runOutcomes(staged: StagedBundle) {
  return (await readStagedRun(root, staged)).mutationOutcomes;
}

describe("recovery keeps the dedupe's satisfying id", () => {
  it("a crash between the child event and the outcome recovers WITH the existing id", async () => {
    const existing = await appendRelation(root, PROFILE, INPUT);
    const staged = await stageRelationBundle(root, {
      kind: "relation", operation: "create",
      target: { relationType: "cites", from: "papers/a", to: "papers/b" },
      attributes: {}, dependsOn: [], reconciliationRefs: [], precondition: { kind: "absent" },
      postcondition: {
        digest: `sha256:${relationContentHash({ ...INPUT, attributes: {}, evidence: undefined })}`,
        recordId: "rel_promisedcafe00",
      },
    });
    const crashing = buildRuntime({ fault: { async afterApply() { throw new Error("crash after apply"); } } });
    await expect(approveAndApplyOperationBundleLocked(root, approveRequest(staged, crashing)))
      .rejects.toThrow(/crash after apply/);
    const recovered = await recoverOperationRunLocked(root, approveRequest(staged, buildRuntime()));
    expect(recovered.state).toBe("succeeded");
    const skipped = (await runOutcomes(staged)).find((entry) => entry.status === "skipped-idempotent");
    expect(skipped?.detail).toContain(existing.id);
  });
});

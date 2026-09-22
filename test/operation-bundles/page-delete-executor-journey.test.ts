/**
 * @file test/operation-bundles/page-delete-executor-journey.test.ts
 * @description AS-1R `edit` authored-DELETE, driven through the REAL executor
 * (not the adapter in isolation): the three clauses the delete bundle seam must
 * hold.
 *
 *  - APPLY: a delete under the correct precondition removes the page.
 *  - STALE: a page changed since the proposal PARKS at recovery-required — the
 *    delete mutation fails its effect protocol and the changed page stands, never
 *    blind-deleted.
 *  - CRASH REPLAY: a host kill BEFORE the delete effect lands leaves the page in
 *    place; recovery replays the started-without-outcome mutation to a single
 *    completed deletion, and a second recovery is idempotent.
 */

import { existsSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { useFileProject } from "../fixtures/file-project.js";
import { journeyTarget, expectPageConflict } from "./page-journey-fixture.js";
import { approveAndApplyOperationBundleLocked } from "../../src/operation-bundles/executor.js";
import { recoverOperationRunLocked } from "../../src/operation-bundles/recovery.js";
import { approveRequest, buildRuntime, stagePageDeleteBundle } from "./executor-fixtures.js";

const DIR = "notes";
const SLUG = "doomed";
const BODY = Buffer.from("# a page slated for deletion\n");

let root = "";
const createProject = useFileProject("page-delete-exec-");
beforeEach(async () => { root = await createProject({}); });

const { seed, pagePath } = journeyTarget(() => root, DIR, SLUG);

describe("authored page delete — full journey through the executor", () => {
  it("APPLIES the delete and removes the page under the correct precondition", async () => {
    await seed(BODY);
    const staged = await stagePageDeleteBundle(root, DIR, SLUG, BODY);
    const result = await approveAndApplyOperationBundleLocked(root, approveRequest(staged, buildRuntime()));
    expect(result.state, JSON.stringify(result.problems)).toBe("succeeded");
    expect(existsSync(pagePath()), "the page survived the delete").toBe(false);
  });

  it("PARKS at recovery-required WITHOUT deleting when the page changed since the proposal", async () => {
    await seed(BODY);
    const staged = await stagePageDeleteBundle(root, DIR, SLUG, BODY); // precondition over BODY
    await seed(Buffer.from("# edited since the delete was proposed\n"));
    await expectPageConflict(root, staged);
    expect(existsSync(pagePath()), "a stale delete removed the changed page").toBe(true);
  });

  it("REPLAYS a crash before the delete lands into a single completed deletion", async () => {
    await seed(BODY);
    const staged = await stagePageDeleteBundle(root, DIR, SLUG, BODY);
    // A host kill BEFORE the effect lands: the mutation is durably started, with
    // no outcome recorded and the page still present.
    const crashing = buildRuntime({ fault: { async beforeApply() { throw new Error("host kill before apply"); } } });
    await expect(approveAndApplyOperationBundleLocked(root, approveRequest(staged, crashing)))
      .rejects.toThrow("host kill");
    expect(existsSync(pagePath()), "the delete ran despite a crash before apply").toBe(true);
    // Recovery replays the started mutation and completes the deletion.
    const recovered = await recoverOperationRunLocked(root, approveRequest(staged, buildRuntime()));
    expect(recovered.state, JSON.stringify(recovered.problems)).toBe("succeeded");
    expect(existsSync(pagePath()), "recovery did not complete the deletion").toBe(false);
    // Exactly once: a second recovery sees the goal already met, no error.
    const again = await recoverOperationRunLocked(root, approveRequest(staged, buildRuntime()));
    expect(again.state).toBe("succeeded");
  });
});

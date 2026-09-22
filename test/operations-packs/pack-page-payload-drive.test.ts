/**
 * @file test/operations-packs/pack-page-payload-drive.test.ts
 * @description S1: the page-payload rule proven GENERIC — a demo fixture pack's
 * artifact-upsert draft lands as a REAL page (frontmatter in sorted key order,
 * the `listFields` hint emitting a one-element list, the `content` field as the
 * body), and the store it wrote RE-DRIVES cleanly: a reconcile action's
 * snapshot ADMITS the written page instead of refusing. That re-drive is the
 * generic second-invocation witness: the installed profile REQUIRES `title`
 * and `tags`, so a payload that was not a real page (a raw canonical-JSON
 * record parses as empty frontmatter) would fail the collector and refuse the
 * snapshot — a product that poisons its own store. Nothing here is
 * product-shaped: every id is the demo pack's own.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCliOperationRuntime } from "../../src/operation-bundles/runtime-factory.js";
import { applyProductBundle } from "../../src/products/apply.js";
import {
  compilePagePayloadAction, compileReconcilePaperAction, driveStagedRun, phaseStates,
  resultReason, stageActionIn, stageCompiledAction, stagedRunTracker, type StagedPackRunV1,
} from "./runtime-fixture.js";

const tracker = stagedRunTracker();
afterEach(() => tracker.cleanupAll());

/** The profile the written page must satisfy: title and a REQUIRED list field. */
const PROFILE = JSON.stringify({
  schemaVersion: 1, profileId: "s1-test", displayName: "S1",
  entities: {
    "wiki-page": {
      directory: "wiki/wiki-page",
      fields: {
        title: { type: "string", required: true },
        tags: { type: "string[]", required: true },
      },
    },
  },
});

/** Drive the page-payload action to a handoff and APPLY it in a profiled root. */
async function appliedPageRun(): Promise<StagedPackRunV1> {
  const run = tracker.add(await stageCompiledAction(
    await compilePagePayloadAction({ topic: "superconductivity", tag: "physics" })));
  await mkdir(path.join(run.root, ".llmwiki"), { recursive: true });
  await writeFile(path.join(run.root, ".llmwiki", "profile.json"), PROFILE, "utf8");
  const result = await driveStagedRun(run);
  expect(result.status, resultReason(result)).toBe("handed-off");
  const outcome = await applyProductBundle({
    root: run.root, principal: { id: "s1-test", surface: "cli", grants: ["operation-bundle.approve"] },
    runtime: createCliOperationRuntime(),
  }, { bundle: (result as { bundleManifestDigest: string }).bundleManifestDigest });
  expect(outcome.status, JSON.stringify(outcome)).toBe("applied");
  return run;
}

describe("S1: the page payload is a real page the store can re-read", () => {
  it("applies the draft as frontmatter + body with the list hint honored", async () => {
    const run = await appliedPageRun();
    const page = await readFile(path.join(run.root, "wiki", "wiki-page", "action-input.md"), "utf8");
    expect(page.startsWith("---\n")).toBe(true);
    expect(page).toContain('title: "superconductivity"');
    expect(page).toContain('tags: ["physics"]');
    expect(page).toMatch(/---\nBody text\.\n$/);
  });

  it("re-drives over its own output: the reconcile snapshot ADMITS the written page", async () => {
    // The second invocation's compare phase reads the store the first wrote.
    // SUCCEEDING here means the collector accepted the page against the
    // required-fields profile; a non-page payload refuses the whole snapshot.
    const run = await appliedPageRun();
    const second = await stageActionIn(run.root,
      await compileReconcilePaperAction({ topic: "superconductivity", doi: "10.1/abc" }));
    const result = await driveStagedRun(second);
    expect(result.status, resultReason(result)).toBe("handed-off");
    expect((await phaseStates(second)).get("compare")).toBe("succeeded");
  });
});

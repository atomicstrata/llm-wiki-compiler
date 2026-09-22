/**
 * @file test/operations-packs/pack-reconcile-drive.test.ts
 * @description G2: the reconcile family runs against the CURRENT store, proven on
 * the pick -> compare -> propose paper action. The `compare` phase classifies the
 * proposed paper against a snapshot of the project's `wiki-page` entity pages:
 * an empty store classifies it `absent`, and a pre-existing page under the SAME
 * slug with DIFFERENT frontmatter classifies it `conflicting` — the AS-1
 * "surface identity collisions" phase, published as durable findings that the
 * downstream intent/apply decision can read.
 *
 * THE SNAPSHOT REFUSES RATHER THAN LYING: a project whose profile file is
 * unreadable settles the compare phase failed with
 * `pack-store-snapshot-unavailable`, because "couldn't read the store" reported
 * as "no collision" is exactly the wrong answer for a collision check.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compileReconcilePaperAction, driveStagedRun, phaseStates, readPhaseOutput,
  resultReason, stageCompiledAction, stagedRunTracker, type StagedPackRunV1,
} from "./runtime-fixture.js";

const tracker = stagedRunTracker();
afterEach(() => tracker.cleanupAll());

const INPUT = { topic: "superconductivity", doi: "10.1/abc" } as const;

/** A minimal profile declaring the compared `wiki-page` entity type. */
const PROFILE = JSON.stringify({
  schemaVersion: 1, profileId: "g2-test", displayName: "G2",
  entities: { "wiki-page": { directory: "wiki/wiki-page" } },
});

/** Stage the reconcile action and install the minimal profile beside it. */
async function stagedWithProfile(): Promise<StagedPackRunV1> {
  const run = tracker.add(await stageCompiledAction(await compileReconcilePaperAction(INPUT)));
  await mkdir(path.join(run.root, ".llmwiki"), { recursive: true });
  await writeFile(path.join(run.root, ".llmwiki", "profile.json"), PROFILE, "utf8");
  return run;
}

/** Create the colliding page: same slug as the proposal, different frontmatter. */
async function plantCollidingPage(root: string): Promise<void> {
  const dir = path.join(root, "wiki", "wiki-page");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "action-input.md"),
    `---\ntopic: old-topic\ndoi: 10.1/abc\n---\n\nExisting page.\n`, "utf8");
}

/** Drive one profiled project (optionally with the colliding page) to findings. */
async function drivenFindings(withCollidingPage: boolean): Promise<unknown> {
  const run = await stagedWithProfile();
  if (withCollidingPage) await plantCollidingPage(run.root);
  const result = await driveStagedRun(run);
  expect(result.status, resultReason(result)).toBe("handed-off");
  const published = await readPhaseOutput(run, "compare") as { findings: unknown };
  return published.findings;
}

describe("G2: reconcile classifies proposals against the current store", () => {
  it("classifies the proposed paper ABSENT on a store with no pages", async () => {
    expect(await drivenFindings(false)).toEqual([
      { identity: "action-input", findingClass: "absent" },
    ]);
  });

  it("classifies the SAME slug with different frontmatter as CONFLICTING", async () => {
    expect(await drivenFindings(true)).toEqual([
      { identity: "action-input", findingClass: "conflicting" },
    ]);
  });

  it("refuses rather than reporting absent when the profile is unreadable", async () => {
    // pick SUCCEEDING while compare FAILS discriminates the snapshot leg: the
    // corrupt profile touches nothing the chaining path reads, so the one thing
    // that can have failed the phase is the store snapshot refusing. WHICH
    // refusal fired is unobservable here (PhaseSummaryV1 records no problem
    // code); store-snapshot.test.ts pins it for these SAME corrupt bytes.
    const run = await stagedWithProfile();
    await writeFile(path.join(run.root, ".llmwiki", "profile.json"), "not json {{{", "utf8");
    const result = await driveStagedRun(run);
    expect(result.status).not.toBe("handed-off");
    expect(Object.fromEntries(await phaseStates(run)))
      .toMatchObject({ pick: "succeeded", compare: "failed" });
  });
});

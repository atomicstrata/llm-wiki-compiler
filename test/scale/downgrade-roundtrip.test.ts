/**
 * @file test/scale/downgrade-roundtrip.test.ts
 * @description Logical round trips through every local layout on real disk,
 * each step in its own child process. The logical content (events, relation
 * records, the workspace catalog, the compile state and the page vectors,
 * read through the ordinary routes of whichever layout is active) is the SAME
 * after every step:
 * - `local-indexed` → `local-large` (the binary container selected);
 * - `local-standard` → `local-indexed` → `local-large` → `local-indexed`
 *   (an ordinary `scale set` preparing new stores from the current files) →
 *   `local-standard`, leaving two retained archives.
 */

import { describe, expect, it } from "bun:test";
import { ok, planFileFor, useDowngradeProjects } from "./downgrade-helpers.js";

/**
 * The NAMED budget of both durable journeys in this file (each step in its own
 * child process with real durable commits), measured on the slow durable test
 * volume:
 * - the full journey (indexed, large, indexed again and standard) timed out at
 *   checkpoint 44 at the shared 900 s case budget: its build took 237 syncs
 *   (386.6 s in sync calls), the apply to local-large 194 (295.1 s) and the
 *   reupgrade 126 (173.1 s), about 855 s in sync calls before the final apply;
 * - the indexed → local-large case timed out at checkpoint 53 at that same
 *   900 s budget: its build took 611.5 s (237 syncs, 602.5 s in sync calls),
 *   the snapshot 79.2 s, the preview 2.2 s and the apply 348.0 s (194 syncs,
 *   325.4 s in sync calls), so the apply ended about 1,071.8 s into the case.
 * A pass under this budget shows the behaviour on slow storage, not speed or
 * any capacity bound. (A child still running when its case times out is not
 * stopped by the shared helper; that is known test-harness debt.)
 */
const DURABLE_JOURNEY_TIMEOUT_MS = 1_800_000;

const projects = useDowngradeProjects();

/** A snapshot without the fields that name the layout. */
function logical(snapshot: Record<string, unknown>): Record<string, unknown> {
  return { ...snapshot, active: undefined, version: undefined, readiness: undefined };
}

/** The two page ids the build fixture seeds in its embedding store. */
const SEEDED_VECTOR_KEYS = ["concepts/page-0", "concepts/page-1"];

/** Prove the initial snapshot carries exactly the seeded vectors, so equality later cannot hold over two empty maps. */
function expectSeededVectors(snapshot: Record<string, unknown>): void {
  expect(Object.keys(snapshot.vectors as Record<string, unknown>).sort()).toEqual(SEEDED_VECTOR_KEYS);
}

/** Scale `root` down to `target` with an estimate of `documents`; returns the new snapshot. */
async function downgrade(root: string, target: string, documents: string, tag: string): Promise<Record<string, unknown>> {
  const preview = await ok<{ ready: boolean }>("preview", root, target, documents, planFileFor(root, tag));
  expect(preview.ready).toBe(true);
  await ok("apply", root, planFileFor(root, tag));
  return ok<Record<string, unknown>>("snapshot", root);
}

describe("logical round trips", () => {
  it("scales an indexed project down to local-large with the same content", async () => {
    const root = await projects.build("build");
    const before = await ok<Record<string, unknown>>("snapshot", root);
    expectSeededVectors(before);
    const after = await downgrade(root, "local-large", "2000", "large");
    expect(logical(after)).toEqual(logical(before));
    expect([after.active, after.version]).toEqual(["local-large", 1]);
  }, DURABLE_JOURNEY_TIMEOUT_MS);

  it("keeps the content through indexed, large, indexed again and standard", async () => {
    const root = await projects.build("build");
    const initial = await ok<Record<string, unknown>>("snapshot", root);
    expectSeededVectors(initial);
    const before = logical(initial);
    const large = await downgrade(root, "local-large", "2000", "first");
    expect([large.active, logical(large)]).toEqual(["local-large", before]);
    expect(await ok("reupgrade", root)).toBe("local-indexed");
    expect(logical(await ok<Record<string, unknown>>("snapshot", root))).toEqual(before);
    const standard = await downgrade(root, "local-standard", "100", "second");
    expect([standard.active, logical(standard)]).toEqual(["local-standard", before]);
    expect(await ok<unknown[]>("archives", root)).toHaveLength(2);
  }, DURABLE_JOURNEY_TIMEOUT_MS);
});

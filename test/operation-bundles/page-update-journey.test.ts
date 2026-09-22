/**
 * @file test/operation-bundles/page-update-journey.test.ts
 * @description The authored page-UPDATE path end to end THROUGH THE EXECUTOR —
 * the first full-apply coverage of an artifact-update. An update's precondition
 * is a digest STATE ({kind, digest}); the byte count rides the postcondition.
 *
 * The safety that matters — never blind-overwriting a page that changed since the
 * proposal — lives in the executor's observe→park step, NOT in the page adapter
 * (whose apply() plans allowOverwrite for an update and would rewrite regardless).
 * So these cases stage a real update bundle and drive `approveAndApply`: the
 * unchanged page applies, and a page mutated after staging PARKS at
 * recovery-required with its bytes byte-identically intact.
 */

import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { useFileProject } from "../fixtures/file-project.js";
import { journeyTarget, expectPageConflict } from "./page-journey-fixture.js";
import { approveAndApplyOperationBundleLocked } from "../../src/operation-bundles/executor.js";
import { readOperationManifest } from "../../src/operation-bundles/manifest-store.js";
import {
  WORKSPACE, approveRequest, buildRuntime, payloadDigest, stagePageUpdateBundle,
} from "./executor-fixtures.js";

const DIR = "notes";
const SLUG = "a";
const V1 = Buffer.from("# note\n\nstage: proposed\n");
const V2 = Buffer.from("# note\n\nstage: proposed\nnovelty-score: 0.72\n");
const STALE = Buffer.from("# note\n\nstage: explored\n");

let root = "";
const createProject = useFileProject("page-update-");
beforeEach(async () => { root = await createProject({}); });

const { seed, pagePath } = journeyTarget(() => root, DIR, SLUG);

describe("authored page update — full journey through the executor", () => {
  it("STAGES the digest-state precondition, APPLIES, and changes the unchanged page", async () => {
    await seed(V1);
    const staged = await stagePageUpdateBundle(root, DIR, SLUG, V1, V2);
    // The materializer-authored {kind,digest} precondition ROUND-TRIPS through
    // real staging + the manifest parser (the shape the #148 fix emits).
    const manifest = await readOperationManifest(root, WORKSPACE, staged.bundleId);
    if (manifest.status !== "ok") throw new Error(`manifest ${manifest.status}`);
    expect(manifest.manifest.mutations[0]?.precondition)
      .toEqual({ kind: "digest", digest: `sha256:${payloadDigest(V1)}` });
    // APPLY through the executor: the page becomes the new bytes.
    const result = await approveAndApplyOperationBundleLocked(root, approveRequest(staged, buildRuntime()));
    expect(result.state, JSON.stringify(result.problems)).toBe("succeeded");
    expect(await readFile(pagePath(), "utf8")).toContain("novelty-score: 0.72");
  });

  it("PARKS at recovery-required WITHOUT overwriting when the page changed after staging", async () => {
    await seed(V1);
    const staged = await stagePageUpdateBundle(root, DIR, SLUG, V1, V2);
    // The page changed since the proposal — to neither the precondition nor the
    // postcondition bytes.
    await seed(STALE);
    // The executor observed the conflict and parked — the update mutation FAILED
    // its effect protocol (a cancel/outage park would not fail the mutation), so
    // nothing was applied.
    await expectPageConflict(root, staged);
    // The changed bytes stand byte-identically — no blind overwrite.
    expect(await readFile(pagePath())).toEqual(STALE);
  });
});

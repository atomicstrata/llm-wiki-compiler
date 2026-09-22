/**
 * @file test/active-profile-digest-genericity.test.ts
 * @description §4.6 genericity evidence for the `activeProfileDigest` core seam (P9.2).
 * Requirement (1) — no product vocabulary/imports — is enforced by the existing
 * `no-research-branch-in-core` + `product-boundary-genericity` gates the seam passes
 * unchanged. Here: (2) a DISSIMILAR (newsroom) consumer exercises the seam — a stable,
 * profile-DISTINCT digest for a product unlike AutoSci; (3) BYTE-IDENTICAL CORE — a
 * fingerprint over the COMPLETE tracked core tree (`git ls-files -z src`, path + raw bytes)
 * is unchanged before/after the seam runs under two dissimilar profiles, so a mutation to
 * ANY tracked core file (any extension) is caught.
 */

import { describe, it, expect } from "vitest";
import { coreTreeFingerprint } from "./fixtures/core-tree-fingerprint.js";
import { activeProfileDigest } from "../src/profile/load.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { installNewsroomProfile } from "./fixtures/newsroom-profile.js";
import { installWorkflowProfile, WORKFLOW_PROFILE } from "./fixtures/workflow-profile.js";

describe("activeProfileDigest — §4.6 genericity", () => {
  it("is a stable, profile-DISTINCT observation for a dissimilar (newsroom) consumer", async () => {
    const newsroom = await makeTempRoot("apd-newsroom");
    await installNewsroomProfile(newsroom);
    const workflow = await makeTempRoot("apd-workflow");
    await installWorkflowProfile(workflow, WORKFLOW_PROFILE);
    const digestN = await activeProfileDigest(newsroom);
    expect(digestN).toMatch(/\S/); // non-empty
    expect(await activeProfileDigest(newsroom)).toBe(digestN); // stable
    expect(await activeProfileDigest(workflow)).not.toBe(digestN); // profile-distinct
  });

  it("leaves the COMPLETE tracked core tree byte-identical when exercised under two profiles", async () => {
    const before = coreTreeFingerprint();
    const newsroom = await makeTempRoot("apd-fp-newsroom");
    await installNewsroomProfile(newsroom);
    const workflow = await makeTempRoot("apd-fp-workflow");
    await installWorkflowProfile(workflow, WORKFLOW_PROFILE);
    expect(await activeProfileDigest(newsroom)).not.toBe(await activeProfileDigest(workflow));
    // A representative product/profile configuration change never edits core.
    expect(coreTreeFingerprint()).toBe(before);
  });
});

/**
 * @file test/profile-status-lifecycle.test.ts
 * @description Status visibility for per-type lifecycle-state counts — the
 * agent-read surface that closes the invisible-write trap.
 *
 * After a `transitionLifecycle` flips a page's lifecycle field, `status` (the
 * primary at-a-glance + MCP `wiki_status` surface) must reflect the new state
 * value, not merely a bumped `eventCount`. These tests assert the additive
 * `profile.lifecycleStates` per-type tally, its multi-state correctness, and the
 * omit-for-default / lifecycle-less parity invariant (the field must NOT appear
 * when no entity type declares a lifecycle, so default envelopes stay identical).
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ProfilePack } from "../src/profile/types.js";
import { collectStatus } from "../src/status/collect.js";
import { createWiki } from "../src/index.js";
import { makeResearchLiteProjectRoot, RESEARCH_LITE_PROFILE } from "./fixtures/profile-fixtures.js";
import { PROFILE_FILE } from "../src/utils/constants.js";

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("collectStatus — lifecycle-state visibility (closes the invisible-write trap)", () => {
  beforeEach(async () => { root = await makeResearchLiteProjectRoot("status-lc-"); });

  it("reflects a draft→review-style transition in profile.lifecycleStates", async () => {
    const wiki = createWiki({ root });
    // The research-lite `ideas` lifecycle: proposed → testing → tested → …
    await wiki.transitionLifecycle({ entityType: "ideas", slug: "sparse-routing", toState: "testing" });
    const result = await collectStatus(root);
    // sparse-routing now `testing`; curriculum-pretraining still seed `proposed`.
    expect(result.profile?.lifecycleStates?.ideas).toEqual({ proposed: 1, testing: 1 });
  });

  it("tallies multiple pages of a lifecycle type by their current state", async () => {
    const wiki = createWiki({ root });
    await wiki.transitionLifecycle({ entityType: "ideas", slug: "sparse-routing", toState: "testing" });
    await wiki.transitionLifecycle({ entityType: "ideas", slug: "sparse-routing", toState: "tested" });
    const result = await collectStatus(root);
    expect(result.profile?.lifecycleStates?.ideas).toEqual({ proposed: 1, tested: 1 });
  });
});

describe("collectStatus — lifecycleStates omit-for-default / lifecycle-less parity", () => {
  it("omits lifecycleStates entirely for the built-in default profile", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "status-lc-default-"));
    const result = await collectStatus(root);
    expect(result.profile).toBeUndefined();
  });

  it("omits lifecycleStates for a non-default profile with NO lifecycle type", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "status-lc-nolc-"));
    const noLifecycle: ProfilePack = {
      schemaVersion: 1,
      profileId: "no-lifecycle",
      entities: { notes: { directory: "wiki/notes" } },
    };
    await mkdir(path.join(root, path.dirname(PROFILE_FILE)), { recursive: true });
    await writeFile(path.join(root, PROFILE_FILE), JSON.stringify(noLifecycle), "utf8");
    await mkdir(path.join(root, "wiki/notes"), { recursive: true });
    await writeFile(path.join(root, "wiki/notes/a.md"), "---\ntitle: A\n---\nBody.");
    const result = await collectStatus(root);
    expect(result.profile?.profileId).toBe("no-lifecycle");
    expect(result.profile && "lifecycleStates" in result.profile).toBe(false);
  });

  it("omits lifecycleStates when a lifecycle type has no enrolled pages", async () => {
    // research-lite seeds `ideas` pages with `status: proposed`, so to exercise
    // the empty-tally omission we point the lifecycle type at an empty dir.
    root = await mkdtemp(path.join(os.tmpdir(), "status-lc-empty-"));
    const onlyEmptyLifecycle: ProfilePack = {
      ...(RESEARCH_LITE_PROFILE as unknown as ProfilePack),
      entities: { ideas: RESEARCH_LITE_PROFILE.entities.ideas as never },
    };
    await mkdir(path.join(root, path.dirname(PROFILE_FILE)), { recursive: true });
    await writeFile(path.join(root, PROFILE_FILE), JSON.stringify(onlyEmptyLifecycle), "utf8");
    const result = await collectStatus(root);
    expect(result.profile && "lifecycleStates" in result.profile).toBe(false);
  });
});

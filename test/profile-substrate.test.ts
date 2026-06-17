/**
 * @file test/profile-substrate.test.ts
 * @description Read-only end-to-end substrate test for the non-default profile
 * path (CLP Phase 0/1, Task 7).
 *
 * Drives the research-lite fixture through every read-only profile surface and
 * asserts they agree: `loadProfile` returns the fixture pack, `collectEntityPages`
 * finds the seeded pages, `collectStatus(...).profile.entityCounts` matches, and
 * `validateProfile` accepts the pack. A DEFAULT project built in the same suite
 * still reports `profile === undefined`, proving no cross-contamination.
 *
 * Negative half (fail-closed): a `schemaVersion: 2` profile and a profile with
 * two entities sharing a directory both throw at the read surface — the loader
 * never presents a partial/degraded project as healthy.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadProfile } from "../src/profile/load.js";
import { collectEntityPages } from "../src/profile/collect.js";
import { validateProfile } from "../src/profile/validate.js";
import { collectStatus } from "../src/status/collect.js";
import { PROFILE_FILE, CONCEPTS_DIR } from "../src/utils/constants.js";
import {
  buildResearchLiteProject,
  RESEARCH_LITE_PROFILE,
} from "./fixtures/profile-fixtures.js";

let root = "";

/** Write a raw `.llmwiki/profile.json` for the negative fail-closed cases. */
async function writeRawProfile(profile: unknown): Promise<void> {
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  await writeFile(path.join(root, PROFILE_FILE), JSON.stringify(profile), "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "profile-substrate-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("research-lite substrate — read surfaces agree", () => {
  beforeEach(async () => {
    await buildResearchLiteProject(root);
  });

  it("loadProfile returns the fixture profile", async () => {
    const loaded = await loadProfile(root);
    expect(loaded.profile.profileId).toBe("research-lite");
    expect(loaded.loadedFrom).toBe(path.join(root, PROFILE_FILE));
    expect(Object.keys(loaded.profile.entities).sort()).toEqual([
      "experiments",
      "ideas",
      "papers",
    ]);
  });

  it("validateProfile accepts the fixture pack", () => {
    const { profile } = validateProfile(RESEARCH_LITE_PROFILE);
    expect(profile.profileId).toBe("research-lite");
  });

  it("collectEntityPages finds the seeded pages", async () => {
    const loaded = await loadProfile(root);
    const refs = await collectEntityPages(root, loaded.profile);
    const ids = refs.map((r) => r.id).sort();
    expect(ids).toContain("papers/scaling-laws");
    expect(ids).toContain("ideas/sparse-routing");
    expect(ids).toContain("experiments/ablation-batch-size");
    expect(ids).toHaveLength(5);
  });

  it("collectStatus.profile.entityCounts matches the seeded pages", async () => {
    const status = await collectStatus(root);
    expect(status.profile?.profileId).toBe("research-lite");
    expect(status.profile?.entityCounts).toEqual({
      papers: 2,
      ideas: 2,
      experiments: 1,
    });
  });
});

describe("default project — no cross-contamination", () => {
  it("a default project still reports profile === undefined", async () => {
    await mkdir(path.join(root, CONCEPTS_DIR), { recursive: true });
    const loaded = await loadProfile(root);
    expect(loaded.profile.profileId).toBe("default");
    const status = await collectStatus(root);
    expect(status.profile).toBeUndefined();
  });
});

describe("research-lite substrate — fail closed", () => {
  it("rejects a profile with schemaVersion 2", async () => {
    await writeRawProfile({ ...RESEARCH_LITE_PROFILE, schemaVersion: 2 });
    await expect(loadProfile(root)).rejects.toThrow(/schemaVersion/);
  });

  it("rejects two entities sharing a directory", async () => {
    await writeRawProfile({
      schemaVersion: 1,
      profileId: "clash",
      entities: {
        papers: { directory: "wiki/shared" },
        ideas: { directory: "wiki/shared" },
      },
    });
    await expect(loadProfile(root)).rejects.toThrow(/share the same directory/);
  });
});

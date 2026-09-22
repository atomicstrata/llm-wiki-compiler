/**
 * Real top-level lint witnesses for the tiered view over profile findings: a
 * single entity collection, declaration-aware confidence filed as a judgement,
 * flat/tiered parity, and narrow default/profile aggregation.
 */
import { afterEach, expect, it, vi } from "vitest";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { lint, lintBothViews, lintByTier } from "../src/linter/index.js";
import * as collection from "../src/profile/collect.js";
import * as profileLoader from "../src/profile/load.js";
import { lintProfileEntities } from "../src/profile/lint.js";
import type { ProfilePack } from "../src/profile/types.js";
import { useLintTempRoot } from "./fixtures/lint-temp-root.js";
import { writeMarkdownPage, writeProfileFile } from "./fixtures/profile-fixtures.js";

const env = useLintTempRoot("profile-tiers");
afterEach(() => vi.restoreAllMocks());

/** Materialize numeric confidence on two distinct paths sharing one slug. */
async function seedConfidence(overlap = false): Promise<ProfilePack> {
  const profile: ProfilePack = { schemaVersion: 1, profileId: "tier-test", entities: {
    notes: { directory: overlap ? "wiki/concepts" : "wiki/notes", fields: { confidence: { type: "number" } } },
    tasks: { directory: "wiki/tasks", fields: { confidence: { type: "number" } } },
  } };
  await writeProfileFile(env.dir, profile);
  for (const def of Object.values(profile.entities)) {
    await writeMarkdownPage(env.dir, def.directory, "same", "---\ntitle: Same\nconfidence: 0.3\n---\nShort.\n");
  }
  return profile;
}

it("collects entity pages once per view and files declared confidence as a judgement", async () => {
  await seedConfidence();
  const spy = vi.spyOn(collection, "collectEntityPages");
  const tiered = await lintByTier(env.dir);
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockClear();
  const flat = await lint(env.dir);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(Object.keys(flat).sort()).toEqual(["errors", "info", "results", "warnings"]);
  expect(tiered.providerJudgement).toEqual(flat.results.filter((r) => r.rule === "low-confidence"));
  expect(tiered.deterministic).toEqual(flat.results.filter((r) => r.rule !== "low-confidence"));
  expect(tiered.derivedView).toEqual([]);
  expect(tiered.deterministicErrors).toBe(0);
});

it("serves both views from one run with shared finding references and flat order", async () => {
  await seedConfidence();
  const spy = vi.spyOn(collection, "collectEntityPages");
  const { summary, tiered } = await lintBothViews(env.dir);
  expect(spy).toHaveBeenCalledTimes(1);
  const regrouped = [...tiered.deterministic, ...tiered.providerJudgement, ...tiered.derivedView];
  expect(regrouped).toHaveLength(summary.results.length);
  for (const finding of regrouped) expect(summary.results).toContain(finding);
  expect(summary.results.map((r) => r.rule)).toEqual(["empty-page", "low-confidence", "empty-page", "low-confidence"]);
  expect(summary.results[0]).not.toHaveProperty("tier");
});

it("adds confidence in the per-page pass for two pages sharing a slug", async () => {
  const profile = await seedConfidence();
  const root = await realpath(env.dir);
  const expected = ["notes", "tasks"].flatMap((entityType) => [
    { rule: "empty-page", severity: "warning", file: path.join(root, `wiki/${entityType}/same.md`), entityType,
      message: "Page body is empty or too short (< 50 chars)" },
    { rule: "low-confidence", severity: "warning", file: path.join(root, `wiki/${entityType}/same.md`), entityType,
      message: "Page confidence 0.30 is below 0.5" },
  ]);
  expect((await lint(env.dir)).results).toEqual(expected);
  expect(await lintProfileEntities(env.dir, profile)).toEqual(expected);
});

it("deduplicates defensive internal-only overlap and keeps default shape", async () => {
  const profile = await seedConfidence(true);
  // Public profile validation rejects overlap; inject only that internal input.
  vi.spyOn(profileLoader, "loadProfile").mockResolvedValue({ profile, loadedFrom: ".llmwiki/profile.json", digest: "test" });
  const { results } = await lint(await realpath(env.dir));
  const confidence = results.filter((r) => r.rule === "low-confidence");
  expect(confidence).toHaveLength(2);
  expect(confidence.map((r) => [r.file.endsWith("wiki/concepts/same.md"), r.entityType]))
    .toEqual([[true, undefined], [false, "tasks"]]);
  expect(confidence[0]).not.toHaveProperty("entityType");
  expect(results.filter((r) => r.rule === "empty-page" && r.file.endsWith("wiki/concepts/same.md"))).toHaveLength(2);
});

it("rejects overlap through the real profile loader", async () => {
  await seedConfidence(true);
  await expect(profileLoader.loadProfile(env.dir)).rejects.toThrow("reserved for the default profile");
});

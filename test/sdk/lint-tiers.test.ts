/**
 * SDK tiered lint witnesses over real profile and default corpus files: the
 * quiet facade exposes the linter's tiered report, files declared confidence as
 * a judgement, never touches a provider, and agrees with the flat summary.
 */
import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from "vitest";
import { readFile, realpath } from "node:fs/promises";
import { createWiki } from "../../src/index.js";
import type { LintSummary, LintTierV1, TieredLintReportV1 } from "../../src/index.js";
import * as providers from "../../src/utils/provider.js";
import * as embeddings from "../../src/utils/embedding-provider.js";
import * as guards from "../../src/utils/provider-guard.js";
import { useLintTempRoot } from "../fixtures/lint-temp-root.js";
import { writeMarkdownPage, writeProfileFile } from "../fixtures/profile-fixtures.js";
import { buildParityCorpus } from "../fixtures/parity-corpus.js";
import { assertNoOutput } from "../fixtures/no-output.js";

const env = useLintTempRoot("sdk-lint-tiers");
const LEGACY_KEYS = ["errors", "info", "results", "warnings"];

/** Fail before credentials, network access or provider construction are possible. */
function rejectProviderAccess(): never {
  throw new Error("SDK lint must never access a provider");
}

beforeEach(async () => {
  vi.spyOn(providers, "getProvider").mockImplementation(rejectProviderAccess);
  vi.spyOn(providers, "buildProvider").mockImplementation(rejectProviderAccess);
  vi.spyOn(embeddings, "getEmbeddingProvider").mockImplementation(rejectProviderAccess);
  vi.spyOn(guards, "ensureProviderAvailable").mockImplementation(rejectProviderAccess);
  vi.spyOn(guards, "ensureCompileProviderAvailable").mockImplementation(rejectProviderAccess);
});
afterEach(() => vi.restoreAllMocks());

/** Seed a real numeric profile with one stored low-confidence judgment. */
async function seedConfidence(): Promise<void> {
  await writeProfileFile(env.dir, {
    schemaVersion: 1, profileId: "sdk-confidence",
    entities: { notes: { directory: "wiki/notes", fields: { confidence: { type: "number" } } } },
  });
  await writeMarkdownPage(env.dir, "wiki/notes", "sample",
    "---\ntitle: Sample\nconfidence: 0.3\n---\nA complete note with enough prose to avoid unrelated empty-page warnings.\n");
}

it("keeps the flat lint summary quiet with exactly the four legacy keys", async () => {
  await seedConfidence();
  const wiki = createWiki({ root: env.dir });
  const pending = wiki.lint();
  expectTypeOf(pending).toEqualTypeOf<Promise<LintSummary>>();
  const flat = await assertNoOutput(() => pending);
  expect(Object.keys(flat).sort()).toEqual(LEGACY_KEYS);
  expect(flat.results).toHaveLength(1);
  expect(flat.results[0]).not.toHaveProperty("tier");
});

it("exposes the tiered report quietly and files declared confidence as a judgement", async () => {
  await seedConfidence();
  const wiki = createWiki({ root: env.dir });
  const pending = wiki.lintByTier();
  expectTypeOf(pending).toEqualTypeOf<Promise<TieredLintReportV1>>();
  expectTypeOf<LintTierV1>().toEqualTypeOf<"deterministic" | "provider-judgement" | "derived-view">();
  const report = await assertNoOutput(() => pending);
  expect(report.deterministic).toEqual([]);
  expect(report.derivedView).toEqual([]);
  expect(report.deterministicErrors).toBe(0);
  expect(report.providerJudgement).toEqual([{
    rule: "low-confidence", severity: "warning", entityType: "notes",
    file: `${await realpath(env.dir)}/wiki/notes/sample.md`,
    message: "Page confidence 0.30 is below 0.5",
  }]);
  expect(report.providerJudgement).toEqual((await wiki.lint()).results);
});

it("regroups actual default parity findings without changing their golden objects", async () => {
  const root = await realpath(env.dir);
  await buildParityCorpus(root);
  const expected = JSON.parse(await readFile(new URL("../parity/__golden__/sdk.lint.json", import.meta.url), "utf8"));
  const report = await createWiki({ root }).lintByTier();
  const regrouped = [...report.deterministic, ...report.providerJudgement, ...report.derivedView];
  const normalized = JSON.parse(JSON.stringify(regrouped).replaceAll(root, "<ROOT>"));
  const byIdentity = (r: { rule: string; file: string }) => `${r.rule}\u0000${r.file}`;
  expect(normalized.map(byIdentity).sort()).toEqual(expected.results.map(byIdentity).sort());
  expect(report.providerJudgement).toEqual([]);
  expect(regrouped).toHaveLength(5);
});

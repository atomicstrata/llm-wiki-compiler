/**
 * Tests for src/eval/cache.ts — citation cache management.
 */

import { mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { clearCitationCache, loadCitationCache, summarizeCitationCache } from "../src/eval/cache.js";
import { useLintTempRoot } from "./fixtures/lint-temp-root.js";
import type { CitationJudgement } from "../src/eval/types.js";

function makeJudgement(overrides: Partial<CitationJudgement> = {}): CitationJudgement {
  return {
    claimHash: "abcd1234abcd1234",
    pageSlug: "my-page",
    citedFile: "source.md",
    lineStart: 1,
    lineEnd: 3,
    claimText: "The algorithm is efficient.",
    spanText: "It runs in O(n) time.",
    score: 2,
    reason: "Source fully supports the claim.",
    model: "claude-test",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

async function writeCacheFile(root: string, judgements: CitationJudgement[]): Promise<void> {
  const cacheDir = path.join(root, ".llmwiki", "eval");
  await mkdir(cacheDir, { recursive: true });
  const lines = judgements.map((j) => JSON.stringify(j)).join("\n");
  await writeFile(path.join(cacheDir, "citation-cache.jsonl"), lines + "\n");
}

describe("clearCitationCache", () => {
  const env = useLintTempRoot("eval-cache-clear");

  it("returns false when cache does not exist", async () => {
    const result = await clearCitationCache(env.dir);
    expect(result).toBe(false);
  });

  it("deletes the cache file and returns true", async () => {
    await writeCacheFile(env.dir, [makeJudgement()]);
    const cachePath = path.join(env.dir, ".llmwiki", "eval", "citation-cache.jsonl");
    expect(existsSync(cachePath)).toBe(true);

    const result = await clearCitationCache(env.dir);
    expect(result).toBe(true);
    expect(existsSync(cachePath)).toBe(false);
  });
});

describe("loadCitationCache", () => {
  const env = useLintTempRoot("eval-cache-load");

  it("returns empty array when cache does not exist", async () => {
    const judgements = await loadCitationCache(env.dir);
    expect(judgements).toHaveLength(0);
  });

  it("loads and parses judgements from the cache file", async () => {
    const j1 = makeJudgement({ score: 2, pageSlug: "page-a" });
    const j2 = makeJudgement({ score: 0, pageSlug: "page-b", claimHash: "bbbb1234bbbb1234" });
    await writeCacheFile(env.dir, [j1, j2]);

    const judgements = await loadCitationCache(env.dir);
    expect(judgements).toHaveLength(2);
    expect(judgements[0].pageSlug).toBe("page-a");
    expect(judgements[1].pageSlug).toBe("page-b");
  });

  it("skips malformed lines without throwing", async () => {
    const cacheDir = path.join(env.dir, ".llmwiki", "eval");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      path.join(cacheDir, "citation-cache.jsonl"),
      `${JSON.stringify(makeJudgement())}\nnot-json\n`,
    );

    const judgements = await loadCitationCache(env.dir);
    expect(judgements).toHaveLength(1);
  });
});

describe("summarizeCitationCache", () => {
  it("returns zero counts for empty array", () => {
    const summary = summarizeCitationCache([]);
    expect(summary.total).toBe(0);
    expect(summary.fullySupported).toBe(0);
    expect(summary.partiallySupported).toBe(0);
    expect(summary.unsupported).toBe(0);
    expect(summary.byPage).toHaveLength(0);
  });

  it("counts scores correctly", () => {
    const judgements = [
      makeJudgement({ score: 2 }),
      makeJudgement({ score: 2, claimHash: "aaaa0001aaaa0001" }),
      makeJudgement({ score: 1, claimHash: "aaaa0002aaaa0002" }),
      makeJudgement({ score: 0, claimHash: "aaaa0003aaaa0003" }),
    ];
    const summary = summarizeCitationCache(judgements);
    expect(summary.total).toBe(4);
    expect(summary.fullySupported).toBe(2);
    expect(summary.partiallySupported).toBe(1);
    expect(summary.unsupported).toBe(1);
  });

  it("groups by page sorted by count descending", () => {
    const judgements = [
      makeJudgement({ pageSlug: "a", claimHash: "aaaa0001aaaa0001" }),
      makeJudgement({ pageSlug: "b", claimHash: "aaaa0002aaaa0002" }),
      makeJudgement({ pageSlug: "a", claimHash: "aaaa0003aaaa0003" }),
      makeJudgement({ pageSlug: "a", claimHash: "aaaa0004aaaa0004" }),
    ];
    const summary = summarizeCitationCache(judgements);
    expect(summary.byPage[0]).toEqual({ slug: "a", count: 3 });
    expect(summary.byPage[1]).toEqual({ slug: "b", count: 1 });
  });
});

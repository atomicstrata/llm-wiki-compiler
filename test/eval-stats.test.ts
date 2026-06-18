/**
 * Tests for src/eval/stats.ts — corpus size tracking and history append.
 */

import { readFile, mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { collectStats, appendHistory, loadHistory, loadLastFullReport } from "../src/eval/stats.js";
import { useLintTempRoot } from "./fixtures/lint-temp-root.js";
import { makeEvalReport } from "./fixtures/eval-report.js";
import type { EvalReport } from "../src/eval/types.js";

describe("collectStats", () => {
  const env = useLintTempRoot("eval-stats");

  it("returns zero counts for an empty project", async () => {
    const result = await collectStats(env.dir);
    expect(result.sourceCount).toBe(0);
    expect(result.pageCount).toBe(0);
    expect(result.totalWikiChars).toBe(0);
    expect(result.embeddingCount).toBe(0);
    expect(result.chunkEmbeddingCount).toBe(0);
    expect(result.avgPageLengthChars).toBe(0);
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("counts source files correctly", async () => {
    await env.writeSource("a.md", "Content A");
    await env.writeSource("b.md", "Content B");

    const result = await collectStats(env.dir);
    expect(result.sourceCount).toBe(2);
  });

  it("counts wiki pages across concepts and queries", async () => {
    await env.writeConcept(
      "concept-one",
      `---\ntitle: One\nsources: []\nsummary: S.\ncreatedAt: 2024-01-01\nupdatedAt: 2024-01-01\n---\n\nBody one.\n`,
    );
    await env.writeQuery(
      "query-one",
      `---\ntitle: Query One\nsources: []\nsummary: S.\ncreatedAt: 2024-01-01\nupdatedAt: 2024-01-01\n---\n\nQuery body.\n`,
    );

    const result = await collectStats(env.dir);
    expect(result.pageCount).toBe(2);
  });

  it("degrades to zero embedding counts when the store is corrupt (regression)", async () => {
    // Stricter store validation makes readEmbeddingStore throw on a corrupt
    // store; stats must degrade, not crash (the one caller the validation
    // change initially left unguarded).
    const storeDir = path.join(env.dir, ".llmwiki");
    await mkdir(storeDir, { recursive: true });
    await writeFile(
      path.join(storeDir, "embeddings.json"),
      JSON.stringify({
        version: 2,
        model: "text-embedding-3-small",
        dimensions: 3, // claims dim 3 but the entry vector is empty -> integrity error
        entries: [{ slug: "a", title: "A", summary: "", vector: [], updatedAt: "2024-01-01" }],
        chunks: [],
      }),
      "utf-8",
    );

    const result = await collectStats(env.dir); // must not throw
    expect(result.embeddingCount).toBe(0);
    expect(result.chunkEmbeddingCount).toBe(0);
  });
});

describe("appendHistory", () => {
  const env = useLintTempRoot("eval-history");

  it("creates history.jsonl on first run", async () => {
    const report = makeEvalReport();
    await appendHistory(env.dir, report);

    const historyPath = path.join(env.dir, ".llmwiki", "eval", "history.jsonl");
    expect(existsSync(historyPath)).toBe(true);

    const content = await readFile(historyPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).health.score).toBe(90);
  });

  it("appends a new line on subsequent runs", async () => {
    await appendHistory(env.dir, makeEvalReport());
    await appendHistory(env.dir, makeEvalReport());

    const historyPath = path.join(env.dir, ".llmwiki", "eval", "history.jsonl");
    const content = await readFile(historyPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
  });
});

describe("loadHistory", () => {
  const env = useLintTempRoot("eval-load-history");

  function makeReport(ts: string): EvalReport {
    return {
      suite: "fast",
      timestamp: ts,
      health: { score: 90, maxScore: 100, rules: [] },
      citationCoverage: {
        totalProseParagraphs: 10,
        citedParagraphs: 8,
        coveragePercent: 80,
        totalCitations: 8,
        validCitations: 8,
        precisionPercent: 100,
        perPage: [],
      },
      stats: {
        timestamp: ts,
        sourceCount: 1,
        pageCount: 1,
        totalWikiChars: 100,
        embeddingCount: 1,
        chunkEmbeddingCount: 5,
        avgPageLengthChars: 100,
      },
      thresholdViolations: [],
    };
  }

  it("returns empty array when no history file exists", async () => {
    const history = await loadHistory(env.dir, 5);
    expect(history).toHaveLength(0);
  });

  it("returns the last N reports from history", async () => {
    await appendHistory(env.dir, makeReport("2026-01-01T00:00:00.000Z"));
    await appendHistory(env.dir, makeReport("2026-01-02T00:00:00.000Z"));
    await appendHistory(env.dir, makeReport("2026-01-03T00:00:00.000Z"));

    const history = await loadHistory(env.dir, 2);
    expect(history).toHaveLength(2);
    expect(history[0].timestamp).toBe("2026-01-02T00:00:00.000Z");
    expect(history[1].timestamp).toBe("2026-01-03T00:00:00.000Z");
  });

  it("returns all reports when n exceeds total count", async () => {
    await appendHistory(env.dir, makeReport("2026-01-01T00:00:00.000Z"));

    const history = await loadHistory(env.dir, 100);
    expect(history).toHaveLength(1);
  });
});

describe("loadLastFullReport", () => {
  const env = useLintTempRoot("eval-last-full");

  it("returns null when history is empty", async () => {
    const result = await loadLastFullReport(env.dir);
    expect(result).toBeNull();
  });

  it("returns null when only fast-suite reports exist", async () => {
    await appendHistory(env.dir, makeEvalReport({ suite: "fast" }));
    const result = await loadLastFullReport(env.dir);
    expect(result).toBeNull();
  });

  it("returns the full-suite report even when a fast report follows it", async () => {
    const sampledHashes = ["hash-a", "hash-b", "hash-c"];
    const fullReport = makeEvalReport({
      suite: "full",
      citationSupport: {
        sampledCount: 3,
        sampledHashes,
        totalCitations: 10,
        meanScore: 1.5,
        fullySupported: 2,
        partiallySupported: 1,
        unsupported: 0,
        judgeErrors: 0,
        judgements: [],
      },
    });
    await appendHistory(env.dir, fullReport);
    await appendHistory(env.dir, makeEvalReport({ suite: "fast" }));

    const result = await loadLastFullReport(env.dir);
    expect(result?.suite).toBe("full");
    expect(result?.citationSupport?.sampledHashes).toEqual(sampledHashes);
  });
});

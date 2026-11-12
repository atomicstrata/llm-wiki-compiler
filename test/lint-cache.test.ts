/**
 * Tests for the lint cache (`.llmwiki/last-lint.json`).
 *
 * Covers both the writer (called by `llmwiki lint` after every completed run)
 * and the reader (consumed by the upcoming viewer's /api/health endpoint).
 * Verifies the on-disk shape, ISO-timestamp contract, missing-cache handling,
 * and malformed-cache rejection so consumers never see partial counts.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import {
  writeLintCache,
  readLintCache,
  LINT_CACHE_TIMESTAMP_PATTERN,
} from "../src/linter/cache.js";
import type { LintCacheEntry } from "../src/linter/cache.js";
import { LAST_LINT_FILE, LLMWIKI_DIR } from "../src/utils/constants.js";
import type { LintSummary } from "../src/linter/types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "lint-cache-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeSummary(errors: number, warnings: number): LintSummary {
  return { errors, warnings, info: 0, results: [] };
}

async function readRawCache(): Promise<string> {
  return readFile(path.join(tmpDir, LAST_LINT_FILE), "utf-8");
}

async function writeRawCache(contents: string): Promise<void> {
  await mkdir(path.join(tmpDir, LLMWIKI_DIR), { recursive: true });
  await writeFile(path.join(tmpDir, LAST_LINT_FILE), contents, "utf-8");
}

describe("writeLintCache", () => {
  it("creates .llmwiki/ recursively when the directory does not exist", async () => {
    await writeLintCache(tmpDir, makeSummary(0, 0));
    expect((await readRawCache()).length).toBeGreaterThan(0);
  });

  it("persists warnings, errors, and an ISO-8601 timestamp", async () => {
    await writeLintCache(tmpDir, makeSummary(3, 5));
    const parsed = JSON.parse(await readRawCache()) as Record<string, unknown>;
    expect(parsed.errors).toBe(3);
    expect(parsed.warnings).toBe(5);
    expect(parsed.at).toMatch(LINT_CACHE_TIMESTAMP_PATTERN);
  });

  it("overwrites a prior cache so zero-issue runs are reflected", async () => {
    await writeLintCache(tmpDir, makeSummary(5, 5));
    await writeLintCache(tmpDir, makeSummary(0, 0));
    const parsed = JSON.parse(await readRawCache()) as Record<string, unknown>;
    expect(parsed.errors).toBe(0);
    expect(parsed.warnings).toBe(0);
  });

  it("persists freshness counts derived from the results to disk", async () => {
    await writeLintCache(tmpDir, {
      errors: 0,
      warnings: 3,
      info: 0,
      results: [
        { rule: "stale-page", severity: "warning", file: "a.md", message: "" },
        { rule: "stale-page", severity: "warning", file: "b.md", message: "" },
        { rule: "orphaned-page", severity: "warning", file: "c.md", message: "" },
      ],
    });
    const parsed = JSON.parse(await readRawCache()) as Record<string, unknown>;
    expect(parsed.freshness).toEqual({ stalePages: 2, orphanedPages: 1 });
  });
});

describe("readLintCache", () => {
  it("returns null when no cache file exists yet", async () => {
    expect(await readLintCache(tmpDir)).toBeNull();
  });

  it("round-trips a freshly written cache", async () => {
    await writeLintCache(tmpDir, makeSummary(2, 4));
    const entry: LintCacheEntry | null = await readLintCache(tmpDir);
    expect(entry?.errors).toBe(2);
    expect(entry?.warnings).toBe(4);
    expect(entry?.at).toMatch(LINT_CACHE_TIMESTAMP_PATTERN);
  });

  it("returns null when the cache file is not valid JSON", async () => {
    await writeRawCache("{not json");
    expect(await readLintCache(tmpDir)).toBeNull();
  });

  it("returns null when required fields have the wrong type", async () => {
    const bad = JSON.stringify({ warnings: "many", errors: 0, at: "2026-01-01T00:00:00.000Z" });
    await writeRawCache(bad);
    expect(await readLintCache(tmpDir)).toBeNull();
  });

  it("returns null when required fields are missing", async () => {
    await writeRawCache(JSON.stringify({ warnings: 1, errors: 1 }));
    expect(await readLintCache(tmpDir)).toBeNull();
  });

  it("rejects negative warning or error counts", async () => {
    const validAt = "2026-05-11T00:00:00.000Z";
    await writeRawCache(JSON.stringify({ warnings: -1, errors: 0, at: validAt }));
    expect(await readLintCache(tmpDir)).toBeNull();
    await writeRawCache(JSON.stringify({ warnings: 0, errors: -5, at: validAt }));
    expect(await readLintCache(tmpDir)).toBeNull();
  });

  it("rejects fractional counts", async () => {
    const validAt = "2026-05-11T00:00:00.000Z";
    await writeRawCache(JSON.stringify({ warnings: 1.5, errors: 0, at: validAt }));
    expect(await readLintCache(tmpDir)).toBeNull();
    await writeRawCache(JSON.stringify({ warnings: 0, errors: 0.1, at: validAt }));
    expect(await readLintCache(tmpDir)).toBeNull();
  });

  it("rejects timestamps that do not match the ISO-8601 contract", async () => {
    await writeRawCache(JSON.stringify({ warnings: 0, errors: 0, at: "2026-05-11" }));
    expect(await readLintCache(tmpDir)).toBeNull();
    await writeRawCache(JSON.stringify({ warnings: 0, errors: 0, at: "" }));
    expect(await readLintCache(tmpDir)).toBeNull();
    await writeRawCache(JSON.stringify({ warnings: 0, errors: 0, at: "2026-05-11T00:00:00Z" }));
    expect(await readLintCache(tmpDir)).toBeNull();
  });
});

describe("freshness counts", () => {
  it("persists and reads back freshness counts", async () => {
    await writeLintCache(tmpDir, {
      errors: 0,
      warnings: 2,
      info: 0,
      results: [
        { rule: "stale-page", severity: "warning", file: "a.md", message: "" },
        { rule: "orphaned-page", severity: "warning", file: "b.md", message: "" },
      ],
    });
    const entry = await readLintCache(tmpDir);
    expect(entry?.freshness).toEqual({ stalePages: 1, orphanedPages: 1 });
  });

  it("reads a pre-upgrade cache (no freshness field) as undefined", async () => {
    await writeRawCache(JSON.stringify({ warnings: 0, errors: 0, at: "2026-06-05T00:00:00.000Z" }));
    const entry = await readLintCache(tmpDir);
    expect(entry?.freshness).toBeUndefined();
  });

  it("rejects the whole entry when freshness is present but malformed", async () => {
    const bad = JSON.stringify({
      warnings: 0,
      errors: 0,
      at: "2026-06-05T00:00:00.000Z",
      freshness: { stalePages: "bad", orphanedPages: 1 },
    });
    await writeRawCache(bad);
    expect(await readLintCache(tmpDir)).toBeNull();
  });
});

describe("rule aggregates", () => {
  it("produces correctly counted, correctly sorted rows across several rules", async () => {
    await writeLintCache(tmpDir, {
      errors: 2,
      warnings: 3,
      info: 0,
      results: [
        { rule: "broken-wikilink", severity: "error", file: "a.md", message: "" },
        { rule: "broken-wikilink", severity: "error", file: "a.md", message: "" },
        { rule: "missing-summary", severity: "warning", file: "a.md", message: "" },
        { rule: "missing-summary", severity: "warning", file: "b.md", message: "" },
        { rule: "empty-page", severity: "warning", file: "c.md", message: "" },
      ],
    });
    const entry = await readLintCache(tmpDir);
    // Tied counts (broken-wikilink vs missing-summary, both 2) break by rule
    // name ascending, so the order is deterministic without a client re-sort.
    expect(entry?.rules).toEqual([
      { rule: "broken-wikilink", severity: "error", count: 2, fileCount: 1, topFile: "a.md", topFileCount: 2 },
      { rule: "missing-summary", severity: "warning", count: 2, fileCount: 2, topFile: "a.md", topFileCount: 1 },
      { rule: "empty-page", severity: "warning", count: 1, fileCount: 1, topFile: "c.md", topFileCount: 1 },
    ]);
  });

  it("stores topFile relative to the project root, never as an absolute filesystem path", async () => {
    // Most rules derive `file` from `path.join(root, ...)` (collectAllPages),
    // so it arrives absolute. /api/health has no loopback-gating for this
    // field (unlike /api/page and /api/index), so the cache itself must
    // never hold a raw local path.
    const absoluteFile = path.join(tmpDir, "wiki", "concepts", "andrej-karpathy.md");
    await writeLintCache(tmpDir, {
      errors: 1,
      warnings: 0,
      info: 0,
      results: [{ rule: "broken-wikilink", severity: "error", file: absoluteFile, message: "" }],
    });
    const entry = await readLintCache(tmpDir);
    const topFile = entry!.rules![0].topFile;
    expect(topFile).toBe(path.join("wiki", "concepts", "andrej-karpathy.md"));
    expect(path.isAbsolute(topFile)).toBe(false);
  });

  it("passes an already-relative file path (infra rules) through unchanged", async () => {
    await writeLintCache(tmpDir, {
      errors: 0,
      warnings: 1,
      info: 0,
      results: [{ rule: "journal-health", severity: "warning", file: ".llmwiki/journal", message: "" }],
    });
    const entry = await readLintCache(tmpDir);
    expect(entry?.rules?.[0].topFile).toBe(".llmwiki/journal");
  });

  it("counts distinct files for fileCount and identifies the worst file as topFile", async () => {
    await writeLintCache(tmpDir, {
      errors: 0,
      warnings: 4,
      info: 0,
      results: [
        { rule: "missing-summary", severity: "warning", file: "a.md", message: "" },
        { rule: "missing-summary", severity: "warning", file: "b.md", message: "" },
        { rule: "missing-summary", severity: "warning", file: "b.md", message: "" },
        { rule: "missing-summary", severity: "warning", file: "b.md", message: "" },
      ],
    });
    const entry = await readLintCache(tmpDir);
    const row = entry?.rules?.find((r) => r.rule === "missing-summary");
    expect(row).toEqual({
      rule: "missing-summary",
      severity: "warning",
      count: 4,
      fileCount: 2,
      topFile: "b.md",
      topFileCount: 3,
    });
  });

  it("excludes info-severity findings from the rows", async () => {
    await writeLintCache(tmpDir, {
      errors: 0,
      warnings: 0,
      info: 2,
      results: [
        { rule: "pending-target", severity: "info", file: "a.md", message: "" },
        { rule: "pending-target", severity: "info", file: "b.md", message: "" },
      ],
    });
    const entry = await readLintCache(tmpDir);
    expect(entry?.rules).toBeUndefined();
  });

  it("reports a rule that emits both severities as error", async () => {
    await writeLintCache(tmpDir, {
      errors: 1,
      warnings: 1,
      info: 0,
      results: [
        { rule: "mixed-rule", severity: "error", file: "a.md", message: "" },
        { rule: "mixed-rule", severity: "warning", file: "b.md", message: "" },
      ],
    });
    const entry = await readLintCache(tmpDir);
    expect(entry?.rules?.[0]).toMatchObject({ rule: "mixed-rule", severity: "error", count: 2 });
  });

  it("reconciles aggregate counts with the headline errors + warnings totals", async () => {
    const summary: LintSummary = {
      errors: 1,
      warnings: 2,
      info: 3,
      results: [
        { rule: "broken-wikilink", severity: "error", file: "a.md", message: "" },
        { rule: "missing-summary", severity: "warning", file: "a.md", message: "" },
        { rule: "missing-summary", severity: "warning", file: "b.md", message: "" },
        { rule: "pending-target", severity: "info", file: "a.md", message: "" },
        { rule: "pending-target", severity: "info", file: "b.md", message: "" },
        { rule: "pending-target", severity: "info", file: "c.md", message: "" },
      ],
    };
    await writeLintCache(tmpDir, summary);
    const entry = await readLintCache(tmpDir);
    const total = entry!.rules!.reduce((sum, r) => sum + r.count, 0);
    expect(total).toBe(summary.errors + summary.warnings);
  });

  it("omits the rules field entirely for a clean run", async () => {
    await writeLintCache(tmpDir, makeSummary(0, 0));
    const parsed = JSON.parse(await readRawCache()) as Record<string, unknown>;
    expect("rules" in parsed).toBe(false);
    const entry = await readLintCache(tmpDir);
    expect(entry?.rules).toBeUndefined();
  });

  it("reads a pre-upgrade cache with no rules field as undefined", async () => {
    await writeRawCache(JSON.stringify({ warnings: 1, errors: 0, at: "2026-06-05T00:00:00.000Z" }));
    const entry = await readLintCache(tmpDir);
    expect(entry).not.toBeNull();
    expect(entry?.rules).toBeUndefined();
  });

  it("rejects the whole entry when rules is present but malformed", async () => {
    const at = "2026-06-05T00:00:00.000Z";
    const base = { rule: "x", severity: "warning", count: 1, fileCount: 1, topFile: "a.md", topFileCount: 1 };
    await writeRawCache(JSON.stringify({ warnings: 1, errors: 0, at, rules: [{ ...base, rule: "" }] }));
    expect(await readLintCache(tmpDir)).toBeNull();
    await writeRawCache(JSON.stringify({ warnings: 1, errors: 0, at, rules: [{ ...base, severity: "info" }] }));
    expect(await readLintCache(tmpDir)).toBeNull();
    await writeRawCache(JSON.stringify({ warnings: 1, errors: 0, at, rules: [{ ...base, count: -1 }] }));
    expect(await readLintCache(tmpDir)).toBeNull();
    await writeRawCache(JSON.stringify({ warnings: 1, errors: 0, at, rules: [{ ...base, topFile: 5 }] }));
    expect(await readLintCache(tmpDir)).toBeNull();
    await writeRawCache(JSON.stringify({ warnings: 1, errors: 0, at, rules: "not-an-array" }));
    expect(await readLintCache(tmpDir)).toBeNull();
  });
});

/**
 * A schema-valid breakdown can still contradict the totals it was derived
 * from. The viewer's Lint panel reads both at once — the chip from
 * `errors + warnings`, the bar's proportions from the rows — so an
 * unreconciled cache renders an impossible sentence beside a bar that
 * disagrees with it. The reader drops only the rows, never the totals.
 */
describe("rule-aggregate invariants", () => {
  const at = "2026-06-05T00:00:00.000Z";
  const row = { rule: "broken-wikilink", severity: "warning", count: 5, fileCount: 2, topFile: "a.md", topFileCount: 3 };

  it("drops rows that do not sum back to errors + warnings, keeping the totals", async () => {
    await writeRawCache(JSON.stringify({ warnings: 4, errors: 6, at, rules: [{ ...row, count: 65 }] }));
    const entry = await readLintCache(tmpDir);
    expect(entry?.rules).toBeUndefined();
    expect(entry).toMatchObject({ warnings: 4, errors: 6, at });
  });

  it("drops rows whose worst file carries more findings than the rule produced", async () => {
    await writeRawCache(JSON.stringify({ warnings: 0, errors: 5, at, rules: [{ ...row, topFileCount: 99 }] }));
    expect((await readLintCache(tmpDir))?.rules).toBeUndefined();
  });

  it("drops rows flagging more distinct files than the rule has findings", async () => {
    await writeRawCache(JSON.stringify({ warnings: 0, errors: 5, at, rules: [{ ...row, fileCount: 9 }] }));
    expect((await readLintCache(tmpDir))?.rules).toBeUndefined();
  });

  it("keeps a breakdown that reconciles with the totals", async () => {
    await writeRawCache(JSON.stringify({ warnings: 1, errors: 4, at, rules: [row] }));
    expect((await readLintCache(tmpDir))?.rules).toEqual([row]);
  });

  it("keeps the freshness counts a dropped breakdown sat beside", async () => {
    const freshness = { stalePages: 1, orphanedPages: 0 };
    const rules = [{ ...row, count: 65 }];
    await writeRawCache(JSON.stringify({ warnings: 4, errors: 6, at, rules, freshness }));
    expect(await readLintCache(tmpDir)).toEqual({ warnings: 4, errors: 6, at, freshness });
  });
});

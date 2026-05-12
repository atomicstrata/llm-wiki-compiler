/**
 * Tests for the lint cache (`.llmwiki/last-lint.json`).
 *
 * Covers both the writer (called by `llmwiki lint` after every completed run)
 * and the reader (consumed by the upcoming viewer's /api/health endpoint).
 * Verifies the on-disk shape, ISO-timestamp contract, missing-cache handling,
 * and malformed-cache rejection so consumers never see partial counts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

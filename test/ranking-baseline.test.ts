/**
 * @file test/ranking-baseline.test.ts
 * @description Frozen consumer-shaped ranking baseline for the re-key parity guard.
 *
 * Freezes all four consumer-facing ranking surfaces for the DEFAULT profile
 * against deterministic mock vectors so D7 (post-migration v3 key) can assert
 * the ranking is key-invariant:
 *   (i)  pageTopK — `findTopK` page scores
 *   (ii) chunkTopK — `findTopKChunks` chunk scores
 *   (iii) collapsedPageOrder — `pickSearchSlugs` BM25-collapsed page list
 *   (iv) contextPrimary — `rankPages` context-pack primary entries
 *
 * NO regen on mismatch — the golden is committed and compared read-only.
 * Run with `UPDATE_GOLDEN=1` (outside CI) to regenerate.
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildRankingBaseline, type RankingBaseline } from "./fixtures/ranking-baseline.js";
import { assertGolden } from "./parity/golden.js";

/** Golden name — maps to test/parity/__golden__/ranking-baseline.json. */
const GOLDEN_NAME = "ranking-baseline";

let root = "";
let baseline: RankingBaseline;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "llmwiki-rank-baseline-"));
  baseline = await buildRankingBaseline(root);
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("ranking baseline golden (re-key parity guard)", () => {
  it("matches the frozen golden (all four sections)", () => {
    assertGolden(GOLDEN_NAME, baseline);
  });
});

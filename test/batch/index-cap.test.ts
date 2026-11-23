/**
 * @file test/batch/index-cap.test.ts
 * @description The batch index's ONE cap: the index step publishes an index
 * of exactly its cap and refuses one byte less of cap, leaving the published
 * index and no temp behind, and the extraction read (`readPageBounded`, the
 * read every next batch extraction makes) accepts and refuses at the very
 * same boundary, so a batch never publishes an index the next one cannot read.
 * The production cap is the shared `MAX_INDEX_BYTES`; a smaller cap reaches
 * the boundary with a small corpus. Every render stamps its generation time
 * (fixed width), so renders are compared with that stamp normalized.
 */

import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { readPageBounded } from "../../src/compiler/batch/pages.js";
import { generateIndexBounded } from "../../src/compiler/batch/residual-index.js";
import { INDEX_FILE } from "../../src/utils/constants.js";
import { writeCorpus } from "../catalog/helpers.js";
import { newScratchBatchRun } from "./scratch-run.js";

/** Run stores are durable segment commits on the external test volume; measured, explicit. */
const STEP_TIMEOUT_MS = 120_000;

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-index-cap-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** Index text with its generation stamp (an ISO time, fixed width) normalized. */
const unstamped = (text: string): string => text.replace(/Generated \d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "Generated <time>");

/** The published index text. */
const publishedIndex = (): Promise<string> => readFile(path.join(root, INDEX_FILE), "utf8");

describe("the batch index cap", () => {
  it("publishes at exactly the cap and refuses below it, at the boundary the extraction read holds", async () => {
    await writeCorpus(root, 6, 0);
    await generateIndexBounded(await newScratchBatchRun(root));
    const first = await publishedIndex();
    const bytes = (await stat(path.join(root, INDEX_FILE))).size;
    await generateIndexBounded(await newScratchBatchRun(root), bytes);
    const atCap = await publishedIndex();
    expect([unstamped(atCap), Buffer.byteLength(atCap)]).toEqual([unstamped(first), bytes]);
    await expect(generateIndexBounded(await newScratchBatchRun(root), bytes - 1)).rejects.toMatchObject({ code: "compile_batch_page_too_large" });
    expect(await publishedIndex()).toBe(atCap);
    expect((await readdir(path.join(root, "wiki"))).sort()).toEqual(["concepts", "index.md", "queries"]);
    expect(await readPageBounded(root, "wiki", "index", bytes)).toEqual({ content: atCap });
    await expect(readPageBounded(root, "wiki", "index", bytes - 1)).rejects.toMatchObject({ code: "compile_batch_page_too_large" });
  }, STEP_TIMEOUT_MS);
});

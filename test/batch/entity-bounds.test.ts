/**
 * @file test/batch/entity-bounds.test.ts
 * @description Custom-profile entity pages in a batch compile, on real disk
 * through the real set-and-prepare bodies: a changed entity page over the
 * batch page cap refuses the run in its residual catalog step
 * (`compile_batch_page_too_large`, naming the page) instead of being
 * allocated, and once the page is shrunk the NEXT compile resumes the SAME run
 * to done with the page catalogued; a typed catalog row too large to store
 * (`live`) is re-projected under the same bound by the index step, which
 * refuses, leaving the published index untouched, once its page outgrows the cap.
 */

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { asEntityFileRow } from "../../src/catalog/entity-rows.js";
import { openActiveCatalog } from "../../src/catalog/routes.js";
import { MAX_PAGE_BYTES } from "../../src/compiler/batch/pages.js";
import { generateIndexBounded } from "../../src/compiler/batch/residual-index.js";
import { activeRunId, BatchRun } from "../../src/compiler/batch/run-store.js";
import { INDEX_FILE } from "../../src/utils/constants.js";
import { SAMPLE_PROFILE, writeMarkdownPage, writeProfileFile } from "../fixtures/profile-fixtures.js";
import { compileUnderTestProvider, segment, sourceNaming, stubDeterministicProvider, useTestProvider, writeSources } from "./helpers.js";
import { newScratchBatchRun } from "./scratch-run.js";

/** Preparing the scale record and compiling run durable segment commits on the external test volume; measured, explicit. */
const COMPILE_TIMEOUT_MS = 300_000;
/** The batch options (a batch compile requires embeddings off). */
const OPTIONS = { batchSize: 10, embeddings: false } as const;

let root: string | undefined;
beforeEach(() => useTestProvider());
afterEach(async () => {
  vi.restoreAllMocks();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

/** A custom-profile project holding `notes` pages and one source, made `local-indexed` with its typed catalog and segmented compile state ready. */
async function typedSegmentedProject(notes: Readonly<Record<string, string>>): Promise<string> {
  const made = await mkdtemp(path.join(tmpdir(), "llmwiki-entity-bounds-"));
  for (const dir of ["wiki/concepts", "wiki/queries", ".llmwiki"]) await mkdir(path.join(made, dir), { recursive: true });
  await writeProfileFile(made, SAMPLE_PROFILE);
  for (const [slug, text] of Object.entries({ alpha: "---\ntitle: Alpha\n---\nA.", ...notes })) await writeMarkdownPage(made, "wiki/notes", slug, text);
  await writeSources(made, { "a.md": sourceNaming("A", "Alpha Concept") });
  await segment(made);
  return made;
}

/** A note of more than `bytes` bytes whose frontmatter carries a `blob` field of that size. */
const wideNote = (bytes: number): string => `---\ntitle: Wide\nblob: ${"y".repeat(bytes)}\n---\nW.`;

/** The stored typed catalog row of note `slug`. */
async function noteRow(project: string, slug: string) {
  return asEntityFileRow(await (await openActiveCatalog(project)).get(`e:notes/${slug}`), `e:notes/${slug}`);
}

describe("an oversized custom-profile entity page in a batch compile", () => {
  it("refuses in the catalog step, and the same run resumes to done once the page is shrunk", async () => {
    root = await typedSegmentedProject({});
    await writeMarkdownPage(root, "wiki/notes", "huge", wideNote(MAX_PAGE_BYTES));
    stubDeterministicProvider();
    await expect(compileUnderTestProvider(root, OPTIONS)).rejects.toMatchObject({ code: "compile_batch_page_too_large", message: expect.stringContaining("huge.md") });
    const runId = (await activeRunId(root))!;
    const stopped = (await BatchRun.open(root, runId)).meta;
    expect([stopped.phase, stopped.cursor.step ?? "catalog"]).toEqual(["residual", "catalog"]);
    await writeMarkdownPage(root, "wiki/notes", "huge", "---\ntitle: Huge\n---\nNow small.");
    const resumed = await compileUnderTestProvider(root, OPTIONS) as { batch?: { runId: string; phase: string } };
    expect(resumed.batch).toMatchObject({ runId, phase: "done" });
    expect((await noteRow(root, "huge")).page).toMatchObject({ title: "Huge" });
  }, COMPILE_TIMEOUT_MS);
});

describe("a live typed catalog row in the batch index step", () => {
  it("is re-projected under the bound, and refuses once its page outgrows the cap", async () => {
    root = await typedSegmentedProject({ wide: wideNote(600 * 1024) });
    expect((await noteRow(root, "wide")).page).toBe("live");
    await generateIndexBounded(await newScratchBatchRun(root));
    const index = await readFile(path.join(root, INDEX_FILE), "utf8");
    expect(index).toContain("Wide");
    await writeMarkdownPage(root, "wiki/notes", "wide", wideNote(MAX_PAGE_BYTES));
    await expect(generateIndexBounded(await newScratchBatchRun(root))).rejects.toMatchObject({ code: "compile_batch_page_too_large" });
    expect(await readFile(path.join(root, INDEX_FILE), "utf8")).toBe(index);
  }, COMPILE_TIMEOUT_MS);
});

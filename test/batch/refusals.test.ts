/**
 * @file test/batch/refusals.test.ts
 * @description What the batch route refuses BEFORE any effect: batch options
 * on a project the incumbent body compiles; on a segmented project, review
 * mode, a change filter, skipped seed pages, `--no-pages-limit`, pending
 * review candidates, an embeddings refresh and `compileDelta`. A refusal
 * leaves no run store, writes no page and sends nothing to a model: no double
 * is installed here, so any model call would throw.
 */

import { mkdir, mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { afterAll, afterEach, beforeAll, beforeEach } from "../config/storage-profile-hooks.js";
import { compileDelta } from "../../src/compiler/delta.js";
import { compileUnderTestProvider, modelCallCount, segment, sourceNaming, useTestProvider, writeSources } from "./helpers.js";

/** Preparing the segmented project costs tens of durable commits; on a busy test volume each took several seconds (measured about 9 s). */
const FIXTURE_TIMEOUT_MS = 600_000;
let root = "";

beforeAll(async () => {
  useTestProvider();
  root = await mkdtemp(path.join(tmpdir(), "llmwiki-batch-refusals-"));
  await writeSources(root, { "a.md": sourceNaming("A", "Idea") });
  await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
  await segment(root);
}, FIXTURE_TIMEOUT_MS);
beforeEach(() => useTestProvider());
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

/** Whether the project holds any run store or concept page. */
async function untouched(): Promise<boolean> {
  const stores = await readdir(path.join(root, ".llmwiki", "indexed"));
  const pages = await readdir(path.join(root, "wiki", "concepts"));
  return !stores.some((store) => store.startsWith("crun-")) && pages.length === 0;
}

describe("batch compile refusals", () => {
  it("refuse batch options on a project the incumbent body compiles", async () => {
    const plain = await mkdtemp(path.join(tmpdir(), "llmwiki-batch-plain-"));
    await expect(compileUnderTestProvider(plain, { batchSize: 2 })).rejects.toThrow(/compile_batch_unsupported_option/);
    await expect(compileUnderTestProvider(plain, { restart: true })).rejects.toThrow(/compile_batch_unsupported_option/);
    await rm(plain, { recursive: true, force: true });
  });

  it.each([
    ["review mode", { review: true }],
    ["a change filter", { changeFilter: () => true }],
    ["skipped seed pages", { skipSeedPages: true }],
    ["--no-pages-limit", { noPagesLimit: true, embeddings: false }],
    ["a batch size out of range", { batchSize: 0 }],
  ])("refuse %s before any effect", async (_label, options) => {
    await expect(compileUnderTestProvider(root, options)).rejects.toThrow(/compile_batch_unsupported_option/);
    expect(await untouched()).toBe(true);
    expect(modelCallCount()).toBe(0);
  });

  it("refuse while review candidates are pending", async () => {
    const candidate = path.join(root, ".llmwiki", "candidates", "idea-0001.json");
    await mkdir(path.dirname(candidate), { recursive: true });
    await writeFile(candidate, "{}");
    await expect(compileUnderTestProvider(root, { embeddings: false })).rejects.toThrow(/review candidates are pending/);
    await unlink(candidate);
    expect(await untouched()).toBe(true);
  });

  it("refuse an embeddings refresh (a supported-option limit) and name the switch", async () => {
    await expect(compileUnderTestProvider(root)).rejects.toThrow(/compile_batch_unsupported_option.*--no-embeddings/);
    expect(await untouched()).toBe(true);
  });

  it("refuse compileDelta on a segmented project", async () => {
    await expect(compileDelta(root)).rejects.toThrow(/compileDelta is not available on a segmented project/);
    expect(await untouched()).toBe(true);
  });
});

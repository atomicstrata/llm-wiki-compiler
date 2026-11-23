/**
 * @file test/batch/bounded-reads.test.ts
 * @description Bounded reads at the batch compile's public and provider-facing
 * edges: a persisted report line outside the closed report shape is a typed
 * refusal, never echoed; the citation check a generated page always runs asks
 * only whether a barely cited source exists (it never reads it), and a span
 * citation to a source over the batch source cap refuses instead of reading it
 * whole.
 */

import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { batchAccess } from "../../src/compiler/batch/access.js";
import { readReport } from "../../src/compiler/batch/report.js";
import { MAX_SOURCE_BYTES } from "../../src/compiler/batch/sources.js";
import { newScratchBatchRun } from "./scratch-run.js";

/** Run stores commit durably on the test volume. */
const READS_TIMEOUT_MS = 120_000;
let root = "";

beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-batch-reads-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });


describe("bounded batch reads", () => {
  it("refuses a malformed persisted report line", async () => {
    const run = await newScratchBatchRun(root);
    await run.put("r:000000000000", { kind: "page", slug: "ok", created: true });
    await run.put("r:000000000001", { kind: "error", message: "x".repeat(100_000) });
    await run.advance("done");
    await expect(readReport(root, run.runId)).rejects.toMatchObject({ code: "compile_batch_run_unknown" });
  }, READS_TIMEOUT_MS);

  it("checks a bare citation of an oversized source without reading it, and refuses a span citation to it", async () => {
    await mkdir(path.join(root, "sources"), { recursive: true });
    await writeFile(path.join(root, "sources", "huge.md"), "");
    await truncate(path.join(root, "sources", "huge.md"), MAX_SOURCE_BYTES + 1);
    const access = batchAccess(await newScratchBatchRun(root));
    expect(await access.checkBrokenCitations("Claim.^[huge.md]\n", "wiki/concepts/x.md")).toEqual([]);
    await expect(access.checkBrokenCitations("Claim.^[huge.md:1-2]\n", "wiki/concepts/x.md")).rejects.toMatchObject({ code: "compile_batch_source_unreadable" });
  }, READS_TIMEOUT_MS);
});

/**
 * @file test/batch/fanin.test.ts
 * @description The batch compile's fan-in bounds, both checked before ANY page
 * generation: through the real driver, two sources whose merged input for one
 * shared page passes the page-input byte cap refuse
 * (`compile_batch_fanin_exceeded`) with no generation call and no page; and
 * the generation plan itself refuses a page with more contributions than the
 * owner cap (a planned-row fixture: extraction and contribution rows exactly
 * as the extract phase records them).
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { contributionKey, MAX_PAGE_INPUT_BYTES, MAX_PAGE_OWNERS, seqKey } from "../../src/compiler/batch/contracts.js";
import type { ExtractionRowV1 } from "../../src/compiler/batch/extract.js";
import { runGenerationPlan } from "../../src/compiler/batch/generation-plan.js";
import { BatchRun } from "../../src/compiler/batch/run-store.js";
import { diskLocalReads } from "../../src/storage/disk-local-reads.js";
import { compileUnderTestProvider, segment, stubDeterministicProvider, useTestProvider, writeSources } from "./helpers.js";

/** Preparing the project and extracting ~9 MiB of sources on the loaded test volume. */
const FANIN_TIMEOUT_MS = 600_000;
const owned: string[] = [];

beforeEach(() => useTestProvider());
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of owned.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("batch compile fan-in", () => {
  it("refuses a page whose merged input passes the byte cap before any page generation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llmwiki-batch-fanin-"));
    owned.push(root);
    const half = "x".repeat(Math.ceil(MAX_PAGE_INPUT_BYTES / 2) + 1024);
    await writeSources(root, { "a.md": `Concepts: Big Idea\n\n${half}\n`, "b.md": `Concepts: Big Idea\n\n${half}\n` });
    await segment(root);
    const calls = stubDeterministicProvider();
    await expect(compileUnderTestProvider(root, { embeddings: false })).rejects.toThrow(/compile_batch_fanin_exceeded/);
    expect(calls.pages).toBe(0);
    expect((await readdir(path.join(root, "wiki", "concepts")).catch(() => [])).length).toBe(0);
  }, FANIN_TIMEOUT_MS);

  it("refuses a planned page with more contributions than the owner cap before planning any generation input", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llmwiki-batch-fanin-count-"));
    owned.push(root);
    const run = await BatchRun.create(root, { batchSize: 10, embeddings: false, identity: { policy: "p", sources: null, cstate: "c" } });
    for (let seq = 0; seq <= MAX_PAGE_OWNERS; seq += 1) {
      const row: ExtractionRowV1 = { file: `s${seq}.md`, concepts: [{ concept: "Hub", summary: "Hub.", is_new: true }], hash: "h", bytes: 1, round: 0 };
      await run.put(seqKey("x:", seq), row);
      await run.put(contributionKey("hub", seq, 0), 1);
    }
    await run.advance("plan-generation");
    await expect(runGenerationPlan(run, diskLocalReads(root))).rejects.toMatchObject({ code: "compile_batch_fanin_exceeded" });
    expect(run.meta.phase).toBe("plan-generation");
  }, FANIN_TIMEOUT_MS);
});

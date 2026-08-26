/**
 * @file test/reconciliation-invalid-replacement.test.ts
 * @description A reconciliation whose replacement page fails validation must
 * stay repairable.
 *
 * Rebuilding a shared page runs extract, merge, generate, validate, write.
 * Validation lives in the renderer's CALLER (`validateWikiPage` in
 * review-pipeline.ts): an invalid body returns `{ error }` and no `liveWrite`,
 * so the slug never reaches `writtenPages`.
 *
 * Extraction succeeding is therefore not evidence the page was replaced, and
 * retiring reconciliation state on it strands the page: the last-known-good
 * body is orphaned, the surviving owner is recorded with no concepts, and the
 * marker is cleared, so the next compile has nothing left telling it to try
 * again. That is the terminal state reconciliation exists to end, reached
 * through the failure path instead of the happy one.
 *
 * A SOFT failure is the case that matters. A thrown provider error aborts the
 * run and leaves state untouched; an output that merely fails validation lets
 * the pipeline continue and retire state around a page that was never written.
 */

import { describe, expect, it, vi } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { compileAndReport } from "../src/compiler/index.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { readState } from "../src/utils/state.js";
import * as embeddings from "../src/utils/embeddings.js";
import { useCompileProject } from "./fixtures/compile-project.js";

const EXTRACTION = JSON.stringify({
  concepts: [{ concept: "Shared Topic", summary: "Shared summary.", is_new: true }],
});

const ctx = useCompileProject({
  dirSuffix: "invalid-replacement",
  sourceFile: "a.md",
  sourceContent: "# Shared Topic\n\nA-only deleted contribution.",
});

/** Two owners of one concept; the replacement body is switchable to invalid. */
async function arrange(): Promise<{ setInvalid: () => void; pageCalls: () => number }> {
  await writeFile(
    path.join(ctx.dir, "sources", "b.md"),
    "# Shared Topic\n\nB-only surviving contribution.",
    "utf-8",
  );
  let invalid = false;
  let pageCalls = 0;
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockResolvedValue(EXTRACTION);
  vi.spyOn(AnthropicProvider.prototype, "complete").mockImplementation(async () => {
    pageCalls += 1;
    if (invalid) return "";
    return "Old claim. ^[a.md:1-2]\n\nShared claim. ^[b.md:1-2]";
  });
  vi.spyOn(embeddings, "updateEmbeddingsLockedCore")
    .mockResolvedValue({ embedded: [], eligible: [] });
  vi.spyOn(console, "log").mockImplementation(() => {});
  return { setInvalid: () => { invalid = true; }, pageCalls: () => pageCalls };
}

/**
 * Compile once cleanly, then delete `a.md` and compile again with the
 * replacement body failing validation. Returns the probe so a caller can read
 * what the failed run left behind.
 */
async function compileThenFailReplacement() {
  const probe = await arrange();
  await compileAndReport(ctx.dir);
  probe.setInvalid();
  await rm(path.join(ctx.dir, "sources", "a.md"));
  await compileAndReport(ctx.dir);
  return probe;
}

describe("a reconciliation whose replacement fails validation", () => {
  it("keeps the marker so a later compile retries", async () => {
    await compileThenFailReplacement();
    const state = await readState(ctx.dir);
    expect(state.frozenSlugs ?? []).toContain("shared-topic");
  });

  it("keeps the surviving owner's claim on the concept", async () => {
    await compileThenFailReplacement();
    const state = await readState(ctx.dir);
    // b.md still owns the concept; recording it with no concepts makes the
    // survivor invisible to the next run's ownership graph.
    expect(state.sources["b.md"]?.concepts ?? []).toContain("shared-topic");
  });

  it("regenerates on the next compile once the model recovers", async () => {
    const probe = await compileThenFailReplacement();
    const before = probe.pageCalls();
    await compileAndReport(ctx.dir);
    expect(probe.pageCalls()).toBeGreaterThan(before);
  });
});

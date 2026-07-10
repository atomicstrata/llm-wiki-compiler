/**
 * @file test/compile-pending-embeddings.test.ts
 * @description Integration coverage for the durable pending-embedding refresh
 * list across two compiles.
 *
 * The compiler flushes source-state (marking sources current) and THEN attempts
 * a failure-swallowing embeddings refresh. This pins that a FAILED refresh on a
 * source-changing compile records the changed page-id to
 * `.llmwiki/pending-embeddings.json`, and that a SUBSEQUENT no-source-change
 * compile DRAINS it — invoking `updateEmbeddingsLockedCore` with the prior id and
 * leaving the marker absent once the refresh succeeds.
 *
 * Fail/succeed is simulated by spying on `updateEmbeddingsLockedCore`: the first
 * compile's spy REJECTS (stands in for a missing API key / transient provider
 * error, which `safelyUpdateEmbeddings` swallows); the second compile's spy
 * RESOLVES.
 */

import { describe, it, expect, vi } from "vitest";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import path from "path";
import { compileAndReport } from "../src/compiler/index.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { PENDING_EMBEDDINGS_FILE } from "../src/utils/constants.js";
import * as embeddings from "../src/utils/embeddings.js";
import { useCompileProject } from "./fixtures/compile-project.js";

const ctx = useCompileProject({
  dirSuffix: "pending-embed",
  sourceFile: "sample.md",
  sourceContent: "# Sample\n\nAlpha is a concept.",
});

const ALPHA_ID = "concepts/alpha";

/** Stub extraction (one concept) + page generation with a fixed body. */
function stubConcepts(): void {
  const extraction = JSON.stringify({
    concepts: [{ concept: "Alpha", summary: "Alpha summary.", is_new: true, confidence: 0.9 }],
  });
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockResolvedValue(extraction);
  vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue("Generated page body.");
  vi.spyOn(console, "log").mockImplementation(() => {});
}

/** Read the durable pending-embeddings marker's page-ids (or [] if absent). */
async function readPendingIds(): Promise<string[]> {
  const file = path.join(ctx.dir, PENDING_EMBEDDINGS_FILE);
  if (!existsSync(file)) return [];
  const entries = JSON.parse(await readFile(file, "utf-8")) as Array<{ pageId: string }>;
  return entries.map((e) => e.pageId);
}

describe("durable pending-embedding refresh list across compiles", () => {
  it("records the page-id on a failed refresh, then drains it on a no-op compile", async () => {
    stubConcepts();

    // Compile 1: a source changed, but the refresh FAILS (swallowed). The
    // write-ahead marker must survive with alpha's qualified page-id.
    const failSpy = vi
      .spyOn(embeddings, "updateEmbeddingsLockedCore")
      .mockRejectedValueOnce(new Error("missing API key"));
    await compileAndReport(ctx.dir);
    expect(failSpy).toHaveBeenCalledTimes(1);
    expect(await readPendingIds()).toContain(ALPHA_ID);

    // Compile 2: NO source changed (same sources), refresh now SUCCEEDS. The
    // drain must invoke the core with the prior-pending id and clear the marker.
    // The core now returns what it embedded + the eligible universe; alpha is
    // both, so settleAfterSuccess clears it.
    const okSpy = vi
      .spyOn(embeddings, "updateEmbeddingsLockedCore")
      .mockResolvedValue({ embedded: [ALPHA_ID], eligible: [ALPHA_ID] });
    const result = await compileAndReport(ctx.dir);

    expect(result.skipped).toBeGreaterThan(0); // no-source-change branch ran
    const drainedIds = okSpy.mock.calls.flatMap((c) => c[1] as string[]);
    expect(drainedIds).toContain(ALPHA_ID);
    expect(await readPendingIds()).toEqual([]); // success cleared the marker
  });
});

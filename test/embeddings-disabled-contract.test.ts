/**
 * With embeddings disabled, no entry point may touch either retry file (#206),
 * yet a page excluded for its old content must still recover once embeddings
 * are re-enabled. Each case excludes a page for its current content, changes
 * that content through one entry point with embeddings off (compile, review
 * approve through the CLI, batch approval, the OKF import refresh, or an edit
 * outside llmwiki), checks both retry files are byte-identical, then turns
 * embeddings on and requires the next refresh to bring the page's chunks current.
 */
import { beforeEach, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { compileAndReport } from "../src/compiler/index.js";
import { refreshAfterImport } from "../src/import/okf-refresh.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { MAX_PENDING_EMBEDDING_ATTEMPTS, QUARANTINED_EMBEDDINGS_FILE } from "../src/utils/constants.js";
import { writePendingEmbeddings } from "../src/utils/pending-embeddings.js";
import { useCompileProject } from "./fixtures/compile-project.js";
import { expectChunksCurrent, liveContentHash } from "./fixtures/embedding-chunks.js";
import { useEmbeddingRefreshEnvironment } from "./fixtures/embedding-refresh.js";
import { drainUnderLock, retryFileBytes, withProjectLock } from "./fixtures/embedding-retry-state.js";
import { approveBatch, stageBatchCandidate } from "./fixtures/review-batch.js";
import { expectCLIExit, runCLI } from "./fixtures/run-cli.js";

const ctx = useCompileProject({ dirSuffix: "disabled-contract", sourceFile: "sample.md", sourceContent: "# Sample\n\nAlpha is a concept." });
const LINKED = "concepts/linked-novel";
useEmbeddingRefreshEnvironment();

beforeEach(() => {
  vi.spyOn(OpenAIProvider.prototype, "embedBatch").mockImplementation(async texts => texts.map(() => [0.5, 0.5]));
});

/** Embed everything, then quarantine the page for its current content. */
async function excludeCurrentContent(pageId: string): Promise<void> {
  await drainUnderLock(ctx.dir);
  const entry = { pageId, attempts: MAX_PENDING_EMBEDDING_ATTEMPTS, contentHash: await liveContentHash(ctx.dir, pageId) };
  await writePendingEmbeddings(ctx.dir, [entry], QUARANTINED_EMBEDDINGS_FILE);
}

/** Change a page with embeddings off, require untouched retry files, then recover with them on. */
async function expectRecoveryAfterDisabledChange(pageId: string, change: () => Promise<void>): Promise<void> {
  const before = await retryFileBytes(ctx.dir);
  vi.stubEnv("LLMWIKI_EMBEDDINGS", "off");
  await change();
  expect(await retryFileBytes(ctx.dir)).toEqual(before);
  vi.stubEnv("LLMWIKI_EMBEDDINGS", "on");
  await expectChunksCurrent(ctx.dir, pageId, false);
  await drainUnderLock(ctx.dir);
  await expectChunksCurrent(ctx.dir, pageId, true);
}

/** Seed a page whose text the resolver links once `novel` is approved. */
async function stageLinkedRewrite(): Promise<string> {
  await writeFile(path.join(ctx.dir, "wiki/concepts/linked-novel.md"), "---\ntitle: Reference\nsummary: Topic reference\n---\nNovel Topic.\n");
  await excludeCurrentContent(LINKED);
  const staged = await stageBatchCandidate(ctx.dir, "novel", { body: "---\ntitle: Novel Topic\n---\nNew text.\n" });
  return staged.id;
}

it("recovers a page that compile regenerated while embeddings were off", async () => {
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockResolvedValue(JSON.stringify({
    concepts: [{ concept: "Alpha", summary: "Alpha summary.", is_new: true, confidence: 0.9 }],
  }));
  const complete = vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue("First page body.");
  await compileAndReport(ctx.dir);
  await excludeCurrentContent("concepts/alpha");
  complete.mockResolvedValue("Revised page body.");
  await writeFile(path.join(ctx.dir, "sources/sample.md"), "# Sample\n\nAlpha is a revised concept.");
  await expectRecoveryAfterDisabledChange("concepts/alpha", async () => { await compileAndReport(ctx.dir); });
});

it("recovers a page that review approve rewrote through the CLI while embeddings were off", async () => {
  const id = await stageLinkedRewrite();
  await expectRecoveryAfterDisabledChange(LINKED, async () => {
    expectCLIExit(await runCLI(["review", "approve", id], ctx.dir, { LLMWIKI_EMBEDDINGS: "off", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" }), 0);
  });
});

it("recovers a page that batch approval rewrote while embeddings were off", async () => {
  const id = await stageLinkedRewrite();
  await expectRecoveryAfterDisabledChange(LINKED, async () => {
    expect((await approveBatch(ctx.dir, id)).status).toBe("completed");
  });
});

it("recovers a page refreshed by an OKF import while embeddings were off", async () => {
  await writeFile(path.join(ctx.dir, "wiki/concepts/imported.md"), "---\ntitle: Imported\nsummary: First\n---\nFirst body.\n");
  await excludeCurrentContent("concepts/imported");
  await expectRecoveryAfterDisabledChange("concepts/imported", async () => {
    await writeFile(path.join(ctx.dir, "wiki/concepts/imported.md"), "---\ntitle: Imported\nsummary: Second\n---\nSecond body.\n");
    await withProjectLock(ctx.dir, () => refreshAfterImport(ctx.dir, ["concepts/imported"]));
  });
});

it("recovers a page edited outside llmwiki while embeddings were off", async () => {
  await writeFile(path.join(ctx.dir, "wiki/concepts/external.md"), "---\ntitle: External\nsummary: First\n---\nFirst body.\n");
  await excludeCurrentContent("concepts/external");
  await expectRecoveryAfterDisabledChange("concepts/external", async () => {
    await writeFile(path.join(ctx.dir, "wiki/concepts/external.md"), "---\ntitle: External\nsummary: Edited\n---\nEdited body.\n");
  });
});

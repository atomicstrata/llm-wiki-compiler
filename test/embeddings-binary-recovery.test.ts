/**
 * Recovery uses the actual embedding update/migration/persistence pipeline.
 * Only provider transport is replaced; unchanged follow-up work must reuse vectors.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";
import * as provider from "../src/utils/embedding-provider.js";
import { updateEmbeddings } from "../src/utils/embeddings.js";
import { readStoreForUpdate } from "../src/utils/embeddings-store.js";

const ctx = useConfinementRoots("binary-recovery");
let embeddedTexts = 0;

beforeEach(() => {
  vi.stubEnv("LLMWIKI_PROVIDER", "openai");
  vi.stubEnv("LLMWIKI_EMBEDDING_PROVIDER", "openai");
  vi.stubEnv("LLMWIKI_EMBEDDING_MODEL", "offline-embed");
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubEnv("LLMWIKI_BINARY_EMBEDDINGS", "");
  vi.stubGlobal("fetch", () => { throw new Error("Network forbidden in binary recovery test"); });
  embeddedTexts = 0;
  vi.spyOn(provider, "getEmbeddingProvider").mockReturnValue({
    embed: async () => { embeddedTexts++; return [0.5, 0.5]; },
    embedBatch: async (texts: string[]) => { embeddedTexts += texts.length; return texts.map(() => [0.5, 0.5]); },
  } as unknown as ReturnType<typeof provider.getEmbeddingProvider>);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("binary recovery through embedding updates", () => {
  it("rebuilds corrupt binary without touching JSON and reuses the repaired vectors", async () => {
    await mkdir(path.join(ctx.root, "wiki/concepts"), { recursive: true });
    await mkdir(path.join(ctx.root, ".llmwiki"), { recursive: true });
    await writeFile(path.join(ctx.root, "wiki/concepts/alpha.md"), "---\ntitle: Alpha\nsummary: S\n---\n\nSource-backed body.");
    const json = path.join(ctx.root, ".llmwiki/embeddings.json");
    await writeFile(json, JSON.stringify({ version: 3, model: "old", dimensions: 0, entries: [], chunks: [] }));
    const backup = await readFile(json);
    const before = await stat(json);
    await writeFile(path.join(ctx.root, ".llmwiki/embeddings.bin"), "corrupt");
    await updateEmbeddings(ctx.root, ["concepts/alpha"]);
    const repaired = await readStoreForUpdate(ctx.root);
    expect(repaired?.store.entries).toEqual([expect.objectContaining({ pageId: "concepts/alpha", vector: [0.5, 0.5] })]);
    expect(embeddedTexts).toBeGreaterThan(0);
    expect(await readFile(json)).toEqual(backup);
    expect((await stat(json)).mtimeMs).toBe(before.mtimeMs);
    const initialCalls = embeddedTexts;
    await updateEmbeddings(ctx.root, []);
    expect(embeddedTexts).toBe(initialCalls);
  });
});

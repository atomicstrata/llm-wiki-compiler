/**
 * @file Exercise host-supplied compiler models through the public SDK and the
 * real whole-store compile pipeline. The ambient model settings are unusable.
 */
import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initWiki, runCompilerOperation, type CompilerOperationModels } from "../../src/index.js";

/** An extraction response and page body for a single synthetic source. */
function modelsFor(calls: string[]): CompilerOperationModels {
  return {
    chat: { provider: "host", model: "writer" },
    extraction: { provider: "host", model: "extractor" },
    embedding: { provider: "host", model: "vectors", dimensions: 2, fingerprint: "a".repeat(64) },
    embeddingBatchSize: 4,
    complete: async (request) => {
      calls.push(request.purpose);
      if (request.purpose === "compile.extract-concepts") {
        return JSON.stringify({ concepts: [{ concept: "Alpha", summary: "A fixture concept.", is_new: true, confidence: 0.95 }] });
      }
      return "Alpha is a synthetic concept in the fixture source.";
    },
    embed: async ({ purpose, inputs }) => {
      calls.push(purpose);
      return inputs.map(() => [1, 0]);
    },
  };
}

/** Create a real compiler project with one stable source. */
async function makeProject(root: string): Promise<void> {
  const wiki = await initWiki({ root });
  await wiki.ingestText({ title: "Fixture", text: "Alpha is a synthetic fixture source for the host compiler. ".repeat(6) });
}

/** Hash exactly the query input bytes. */
async function digest(root: string, file: string): Promise<string> {
  return createHash("sha256").update(await readFile(path.join(root, file))).digest("hex");
}

/** Pin the exact generation bytes read by the fixture query. */
async function pinGeneration(root: string) {
  return {
    indexSha256: await digest(root, "wiki/index.md"),
    storeSha256: await digest(root, ".llmwiki/embeddings.json"),
  };
}

it("uses the host callbacks for extraction, rendering, and embedding", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "llm-wiki-compiler-host-fixture-"));
  const prior = process.env.LLMWIKI_EMBEDDING_PROVIDER;
  process.env.LLMWIKI_EMBEDDING_PROVIDER = "unusable-fixture-provider";
  try {
    await makeProject(root);
    const calls: string[] = [];
    const result = await runCompilerOperation({ kind: "compile", root, models: modelsFor(calls) });
    expect(result.pages).toContain("alpha");
    expect(calls).toContain("compile.extract-concepts");
    expect(calls).toContain("compile.generate-page");
    expect(calls).toContain("compile.embed-documents");
  } finally {
    if (prior === undefined) delete process.env.LLMWIKI_EMBEDDING_PROVIDER;
    else process.env.LLMWIKI_EMBEDDING_PROVIDER = prior;
    await rm(root, { recursive: true, force: true });
  }
});

it("pins query bytes before effects and answers without updating the project log", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "llm-wiki-compiler-host-query-"));
  const prior = process.env.LLMWIKI_STAGE_TIMING_FILE;
  const timing = path.join(root, "timing.jsonl");
  process.env.LLMWIKI_STAGE_TIMING_FILE = timing;
  try {
    await makeProject(root);
    const calls: string[] = [];
    const models = modelsFor(calls);
    await runCompilerOperation({ kind: "compile", root, models });
    calls.length = 0;
    const generation = await pinGeneration(root);
    const log = await digest(root, "log.md");
    const query = { kind: "query", root, models, generation, question: "What is Alpha?" } as const;
    await expect(runCompilerOperation({ ...query, generation: { ...generation, storeSha256: "0".repeat(64) } }))
      .rejects.toMatchObject({ code: "retrieval_index_mismatch" });
    expect(calls).toEqual([]);
    const result = await runCompilerOperation(query);
    expect(result.answer).toContain("Alpha");
    expect(result.pageIds).toContain("concepts/alpha");
    expect(calls.filter((call) => call === "query.embed-question")).toHaveLength(1);
    expect(calls).toContain("query.answer");
    expect(await digest(root, "log.md")).toBe(log);
    await expect(access(timing)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (prior === undefined) delete process.env.LLMWIKI_STAGE_TIMING_FILE;
    else process.env.LLMWIKI_STAGE_TIMING_FILE = prior;
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses a no-op compile over a store missing its eligible chunks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "llm-wiki-compiler-host-missing-chunks-"));
  try {
    await makeProject(root);
    const models = modelsFor([]);
    await runCompilerOperation({ kind: "compile", root, models });
    const file = path.join(root, ".llmwiki/embeddings.json");
    const store = JSON.parse(await readFile(file, "utf8"));
    expect(store.chunks.length).toBeGreaterThan(0);
    await writeFile(file, JSON.stringify({ ...store, chunks: [] }));
    await expect(runCompilerOperation({ kind: "compile", root, models }))
      .rejects.toMatchObject({ code: "compile_incomplete" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("latches an embedding failure that the ordinary compile catches", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "llm-wiki-compiler-host-embed-error-"));
  try {
    await makeProject(root);
    const calls: string[] = [];
    const failure = new Error("network failure");
    const models = {
      ...modelsFor(calls),
      embed: async () => {
        calls.push("failed-embed");
        throw failure;
      },
    };
    await expect(runCompilerOperation({ kind: "compile", root, models })).rejects.toBe(failure);
    expect(calls.filter((call) => call === "failed-embed")).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Run one real compile before collecting the subsequent query effects. */
async function compiledProject(root: string) {
  await makeProject(root);
  const calls: string[] = [];
  const models = modelsFor(calls);
  await runCompilerOperation({ kind: "compile", root, models });
  calls.length = 0;
  return { calls, models };
}

it("refuses stale hits before dispatching chat", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "llm-wiki-compiler-host-stale-"));
  try {
    const { calls, models } = await compiledProject(root);
    const page = path.join(root, "wiki/concepts/alpha.md");
    await writeFile(page, (await readFile(page, "utf8")) + "\nChanged after indexing.\n");
    const generation = await pinGeneration(root);
    const query = { kind: "query", root, models, generation, question: "What is Alpha?" } as const;
    await expect(runCompilerOperation(query)).rejects.toMatchObject({ code: "retrieval_index_outdated" });
    expect(calls).toEqual(["query.embed-question"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("returns empty for a pinned query scope with no vector hits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "llm-wiki-compiler-host-no-hits-"));
  try {
    const { calls, models } = await compiledProject(root);
    const generation = await pinGeneration(root);
    const result = await runCompilerOperation({
      kind: "query", root, models, generation, question: "What is Alpha?", pageScope: ["concepts/missing"],
    });
    expect(result).toMatchObject({ answer: "", pageIds: [], reasoning: "No embedding hits." });
    expect(calls.every((call) => call === "query.embed-question")).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("blocks nested image ingestion before constructing an ambient client", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "llm-wiki-compiler-host-vision-"));
  const prior = process.env.LLMWIKI_PROVIDER;
  process.env.LLMWIKI_PROVIDER = "anthropic";
  try {
    await makeProject(root);
    const wiki = await initWiki({ root });
    const image = path.join(root, "fixture.png");
    await writeFile(image, "fixture");
    const models = {
      ...modelsFor([]),
      complete: async () => {
        await wiki.ingest({ source: image });
        return "";
      },
    };
    await expect(runCompilerOperation({ kind: "compile", root, models }))
      .rejects.toMatchObject({ code: "ambient_provider_blocked" });
  } finally {
    if (prior === undefined) delete process.env.LLMWIKI_PROVIDER;
    else process.env.LLMWIKI_PROVIDER = prior;
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps the compile format independent of an ambient binary opt-in", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "llm-wiki-compiler-host-format-"));
  const prior = process.env.LLMWIKI_BINARY_EMBEDDINGS;
  process.env.LLMWIKI_BINARY_EMBEDDINGS = "1";
  try {
    await makeProject(root);
    await runCompilerOperation({ kind: "compile", root, models: modelsFor([]) });
    await access(path.join(root, ".llmwiki/embeddings.json"));
    await expect(access(path.join(root, ".llmwiki/embeddings.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (prior === undefined) delete process.env.LLMWIKI_BINARY_EMBEDDINGS;
    else process.env.LLMWIKI_BINARY_EMBEDDINGS = prior;
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses missing answer grounding after the selector runs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "llm-wiki-compiler-host-hydration-"));
  try {
    await makeProject(root);
    const calls: string[] = [];
    const models = modelsFor(calls);
    await runCompilerOperation({ kind: "compile", root, models });
    const file = path.join(root, ".llmwiki/embeddings.json");
    const store = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...store, chunks: [] }));
    const generation = await pinGeneration(root);
    calls.length = 0;
    const complete = async ({ purpose }: Parameters<CompilerOperationModels["complete"]>[0]) => {
      calls.push(purpose);
      await rm(path.join(root, "wiki/concepts/alpha.md"));
      return JSON.stringify({ pages: ["concepts/alpha"], reasoning: "Selected fixture." });
    };
    await expect(runCompilerOperation({
      kind: "query", root, models: { ...models, complete }, generation, question: "What is Alpha?",
    })).rejects.toMatchObject({ code: "retrieval_context_incomplete" });
    expect(calls).toEqual(["query.embed-question", "query.select-pages"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Subprocess CLI coverage for chunked-retrieval that requires a working LLM.
 *
 * The existing chunked-retrieval-integration.test.ts file documents two
 * specific gaps that couldn't be exercised at the CLI boundary without a
 * live LLM:
 *
 *   1. Full `compile` → extract → page generation → chunk embedding pipeline
 *      producing a v2 store with chunks on disk.
 *   2. Full `query --debug` flow printing chunk slugs/scores.
 *
 * Now that aimock is in the project (see test/fixtures/aimock-helper.ts),
 * both gaps are closeable by running the subprocesses in OpenAI mode so chat
 * and embedding requests hit the same aimock server.
 */

import { describe, it, expect } from "vitest";
import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import {
  mockOpenAIEnv,
  useAimockLifecycle,
  type MockClaudeHandle,
} from "./fixtures/aimock-helper.js";
import {
  runCLI,
  expectCLIExit,
  formatCLIFailure,
  type CLIResult,
} from "./fixtures/run-cli.js";

const aimock = useAimockLifecycle("cr-aimock");
const EMBEDDING_VECTOR = Array.from({ length: 8 }, (_, i) => i / 10);
const CHUNKED_RETRIEVAL_SOURCE =
  "# Chunked Retrieval\n\nA long-form note about chunk-based vector search.\n";
const CHUNKED_RETRIEVAL_BODY =
  "Chunked retrieval breaks long wiki pages into smaller passages before " +
  "comparing them against a query vector. Each chunk is embedded with the " +
  "active provider's embedding model and persisted on disk under the " +
  "chunks array of .llmwiki/embeddings.json. Reusing chunks across compiles " +
  "via content hashes keeps embedding costs proportional to actual edits, " +
  "not the size of the wiki.";

/** Register canned aimock responses for chunked-retrieval compile/query flows. */
function registerChunkedRetrievalMocks(handle: MockClaudeHandle, body: string): void {
  handle.mock.onToolCall("extract_concepts", {
    toolCalls: [
      {
        name: "extract_concepts",
        arguments: {
          concepts: [
            {
              concept: "Chunked Retrieval",
              summary: "Splitting wiki pages into chunks before vector search.",
              is_new: true,
              tags: ["retrieval"],
              confidence: 0.9,
            },
          ],
        },
      },
    ],
  });
  handle.mock.onMessage(/.*/, { content: body });
  handle.mock.onEmbedding(/.*/, { embedding: EMBEDDING_VECTOR });
}

/** Build a temp project, compile it through the CLI, and return the workspace. */
async function compileChunkedRetrievalProject(
  handle: MockClaudeHandle,
  sourceContent = CHUNKED_RETRIEVAL_SOURCE,
): Promise<{ cwd: string; env: NodeJS.ProcessEnv; result: CLIResult }> {
  const cwd = await aimock.makeWorkspace(sourceContent);
  const env = mockOpenAIEnv(handle);
  const compileResult = await runCLI(["compile"], cwd, env);
  expectCLIExit(compileResult, 0);
  return { cwd, env, result: compileResult };
}

describe("chunked-retrieval subprocess coverage via aimock", () => {
  it("compile populates a v3 embedding store with chunks for newly-generated pages", async () => {
    const handle = await aimock.start();
    registerChunkedRetrievalMocks(handle, CHUNKED_RETRIEVAL_BODY);

    const { cwd, result } = await compileChunkedRetrievalProject(handle);

    // Assert: a wiki page was generated.
    const conceptsDir = path.join(cwd, "wiki", "concepts");
    const conceptFiles = await readdir(conceptsDir);
    const conceptMd = conceptFiles.find((f) => f.endsWith(".md"));
    expect(conceptMd, formatCLIFailure(result)).toBeDefined();

    // Assert: the embedding store exists, version 3 (pageId-keyed), with chunks.
    const storePath = path.join(cwd, ".llmwiki", "embeddings.json");
    expect(existsSync(storePath)).toBe(true);
    const store = JSON.parse(await readFile(storePath, "utf-8")) as {
      version: number;
      entries: Array<{ pageId?: string }>;
      chunks?: Array<{ pageId?: string }>;
    };
    expect(store.version, formatCLIFailure(result)).toBe(3);
    expect(store.entries.length, formatCLIFailure(result)).toBeGreaterThan(0);
    expect((store.chunks ?? []).length, formatCLIFailure(result)).toBeGreaterThan(0);
    // v3 records are keyed by a qualified pageId, not a bare slug.
    expect(store.entries[0].pageId, formatCLIFailure(result)).toMatch(/^concepts\//);
  }, 30_000);

  it("query --debug prints chunk-level retrieval details after an aimock compile", async () => {
    const handle = await aimock.start();
    registerChunkedRetrievalMocks(
      handle,
      "Chunked retrieval answers questions by selecting the most relevant " +
        "embedded passages before loading their parent wiki pages.",
    );
    const { cwd, env } = await compileChunkedRetrievalProject(
      handle,
      "# Chunked Retrieval\n\nA note about chunk-level vector search and debug output.\n",
    );

    const queryResult = await runCLI(
      ["query", "--debug", "how does chunked retrieval work?"],
      cwd,
      env,
    );
    expectCLIExit(queryResult, 0);
    expect(queryResult.stdout).toContain("Retrieval debug");
    expect(queryResult.stdout).toContain("Source: chunk-level");
    expect(queryResult.stdout).toContain("chunked-retrieval");
    expect(queryResult.stdout).toContain("score=");
  }, 30_000);
});

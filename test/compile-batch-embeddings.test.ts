/**
 * Subprocess acceptance test: `compile` sends batched embeddings requests
 * and persists a correct v2 store.
 *
 * Uses aimock to intercept both chat and embedding calls so no real network
 * traffic is needed. Three concepts are emitted so the page-embedding pass
 * must carry input.length > 1, exercising the actual batch path end-to-end.
 */

import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { runCLI, expectCLIExit, formatCLIFailure } from "./fixtures/run-cli.js";
import { useAimockLifecycle, mockOpenAIEnv } from "./fixtures/aimock-helper.js";

const aimock = useAimockLifecycle("batch-embed");
const EMBEDDING_VECTOR = Array.from({ length: 8 }, (_, i) => i / 10);

describe("compile batches embeddings (subprocess)", () => {
  it("sends batched array-input requests AND persists a correct store", async () => {
    const handle = await aimock.start();
    // Three concepts -> three pages -> page-embedding batch carries 3 inputs.
    handle.mock.onToolCall("extract_concepts", {
      toolCalls: [{
        name: "extract_concepts",
        arguments: { concepts: [
          { concept: "Alpha", summary: "First concept.", is_new: true, tags: ["t"], confidence: 0.9 },
          { concept: "Beta", summary: "Second concept.", is_new: true, tags: ["t"], confidence: 0.9 },
          { concept: "Gamma", summary: "Third concept.", is_new: true, tags: ["t"], confidence: 0.9 },
        ] },
      }],
    });
    handle.mock.onMessage(/.*/, { content: "Body paragraph one.\n\nBody paragraph two." });
    handle.mock.onEmbedding(/.*/, { embedding: EMBEDDING_VECTOR });

    const cwd = await aimock.makeWorkspace("# Source\n\nAlpha, Beta, and Gamma are concepts. ".repeat(20));
    const result = await runCLI(["compile"], cwd, mockOpenAIEnv(handle));
    expectCLIExit(result, 0);

    // (a) Batching proof: three pages were embedded in fewer HTTP requests than
    // the number of pages, which can only happen if the page pass batched them.
    // aimock journals embedding requests with _endpointType === "embedding" in
    // body.syntheticReq; count them to verify fewer calls than pages.
    const requests = handle.mock.getRequests() as Array<{ body?: { _endpointType?: string } }>;
    const embeddingRequests = requests.filter((r) => r.body?._endpointType === "embedding");
    // 3 pages + 3 page-sized chunks = at least 6 with sequential; with batching
    // the page pass emits 1 request and the chunk pass emits 1 request = 2 total.
    expect(embeddingRequests.length, formatCLIFailure(result)).toBeLessThan(3);

    // (b) Store correctness — REQUIRED by spec. A v2 store with entries + chunks
    // must actually be persisted; this only passes when the batched responses
    // validate (one vector per input), so it is a genuine end-to-end check.
    const storePath = path.join(cwd, ".llmwiki", "embeddings.json");
    expect(existsSync(storePath), formatCLIFailure(result)).toBe(true);
    const store = JSON.parse(await readFile(storePath, "utf-8")) as {
      version: number; entries: unknown[]; chunks?: unknown[];
    };
    expect(store.version).toBe(2);
    expect(store.entries.length).toBeGreaterThan(0);
    expect((store.chunks ?? []).length).toBeGreaterThan(0);
  }, 60_000);
});

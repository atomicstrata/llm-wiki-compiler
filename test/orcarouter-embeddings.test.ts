/**
 * Exercises gateway embeddings at the HTTP boundary, including independent
 * embedding selection and the model identity used to invalidate stored vectors.
 */
import { afterEach, beforeEach, expect, it } from "bun:test";
import { restoreEnv, restoreGlobals, stubEnv, stubGlobal } from "./stubs.js";
import { getEmbeddingProvider, findEmbeddingProviderProblem } from "../src/utils/embedding-provider.js";
import { resolveEmbeddingModel } from "../src/utils/embeddings-store.js";

beforeEach(() => {
  stubEnv("LLMWIKI_PROVIDER", "orcarouter");
  stubEnv("LLMWIKI_EMBEDDING_PROVIDER", undefined);
  stubEnv("LLMWIKI_EMBEDDING_MODEL", undefined);
  stubEnv("ORCAROUTER_API_KEY", "gateway-key");
  stubEnv("OPENAI_EMBEDDINGS_BASE_URL", "https://wrong.example/v1");
  stubEnv("OPENAI_EMBEDDINGS_API_KEY", "wrong-key");
});
afterEach(() => { restoreEnv(); restoreGlobals(); });

it.each([undefined, "openai/text-embedding-3-large"])("routes vectors and model identity together: %s", async (override) => {
  stubEnv("LLMWIKI_EMBEDDING_MODEL", override);
  const requests: unknown[] = [];
  stubGlobal("fetch", async (url: string, init: RequestInit) => {
    expect(String(url)).toBe("https://api.orcarouter.ai/v1/embeddings");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer gateway-key");
    const body = JSON.parse(String(init.body));
    requests.push(body);
    const data = Array.isArray(body.input)
      ? [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }]
      : [{ index: 0, embedding: [1, 0] }];
    return Response.json({ object: "list", data, model: body.model, usage: { prompt_tokens: 2, total_tokens: 2 } });
  });
  const provider = getEmbeddingProvider();
  expect(await provider.embed("one")).toEqual([1, 0]);
  if (!provider.embedBatch) throw new Error("OrcaRouter must expose batch embeddings");
  expect(await provider.embedBatch(["one", "two"])).toEqual([[1, 0], [0, 1]]);
  const model = override ?? "openai/text-embedding-3-small";
  expect(requests).toEqual([
    { model, input: "one", encoding_format: "float" },
    { model, input: ["one", "two"], encoding_format: "float" },
  ]);
  expect(resolveEmbeddingModel()).toBe(model);
});

it("permits independent gateway selection but requires its own credential", () => {
  stubEnv("LLMWIKI_PROVIDER", "openai");
  stubEnv("LLMWIKI_EMBEDDING_PROVIDER", "orcarouter");
  expect(findEmbeddingProviderProblem()).toBeNull();
  expect(resolveEmbeddingModel()).toBe("openai/text-embedding-3-small");
  stubEnv("ORCAROUTER_API_KEY", " ");
  expect(findEmbeddingProviderProblem()).toMatchObject({ kind: "unavailable", missing: ["ORCAROUTER_API_KEY"] });
  expect(() => getEmbeddingProvider()).toThrow("ORCAROUTER_API_KEY");
});

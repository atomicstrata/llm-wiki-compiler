/**
 * Cheaper Inference registration and request-boundary tests.
 * Keeps credential validation consistent with the guard and verifies that
 * structured extraction reaches the gateway with its own key and bare model id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProvider, resolveActiveModelId } from "../src/utils/provider.js";
import { ensureProviderAvailable } from "../src/utils/provider-guard.js";

const KEY_VAR = "CHEAPER_INFERENCE_API_KEY";
const CHAT_URL = "https://api.cheaperinference.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-5.4-mini";
const EXTRACT_TOOL = { name: "extract", description: "Extract", input_schema: { type: "object" } };

/** Environment for each test: this gateway selected, unrelated OpenAI key present. */
const BASE_ENV: Record<string, string | undefined> = {
  LLMWIKI_PROVIDER: "cheaperinference",
  LLMWIKI_MODEL: undefined,
  LLMWIKI_EMBEDDING_PROVIDER: undefined,
  [KEY_VAR]: "gateway-key",
  OPENAI_API_KEY: "unrelated-openai-key",
};

/** Record the outgoing request and answer it with one `extract` tool call. */
function captureChatRequest(): { url: string; headers: Headers; body: Record<string, unknown> }[] {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    const call = { type: "function", function: { name: "extract", arguments: JSON.stringify({ concepts: ["ci"] }) } };
    return Response.json({ choices: [{ message: { role: "assistant", tool_calls: [call] } }] });
  });
  return requests;
}

describe("Cheaper Inference integration", () => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(BASE_ENV)) vi.stubEnv(name, value);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("rejects unusable credentials in both entry points", () => {
    for (const key of [undefined, "", "   "]) {
      vi.stubEnv(KEY_VAR, key);
      expect(() => ensureProviderAvailable(), JSON.stringify(key)).toThrow(KEY_VAR);
      expect(() => getProvider(), JSON.stringify(key)).toThrow(KEY_VAR);
    }
  });

  it.each([undefined, "claude-sonnet-5"])("sends tool requests to the gateway for model override %j", async (model) => {
    vi.stubEnv("LLMWIKI_MODEL", model);
    vi.stubEnv(KEY_VAR, "  gateway-key  ");
    const requests = captureChatRequest();
    expect(() => ensureProviderAvailable()).not.toThrow();
    expect(resolveActiveModelId()).toBe(model ?? DEFAULT_MODEL);

    const result = await getProvider().toolCall("Extract concepts", [], [EXTRACT_TOOL], 100);

    expect(JSON.parse(result)).toEqual({ concepts: ["ci"] });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(CHAT_URL);
    expect(requests[0].headers.get("authorization")).toBe("Bearer gateway-key");
    expect(requests[0].body).toMatchObject({ model: model ?? DEFAULT_MODEL, tool_choice: "required" });
  });
});

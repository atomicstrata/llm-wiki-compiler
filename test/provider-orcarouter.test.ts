/**
 * OrcaRouter registration and request-boundary tests.
 * Keeps credential validation consistent with the guard and verifies that
 * structured extraction reaches the gateway with its own key and model.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { restoreEnv, restoreGlobals, stubEnv, stubGlobal } from "./stubs.js";
import { getProvider, resolveActiveModelId } from "../src/utils/provider.js";
import { ensureProviderAvailable } from "../src/utils/provider-guard.js";

describe("OrcaRouter integration", () => {
  beforeEach(() => {
    stubEnv("LLMWIKI_PROVIDER", "orcarouter");
    stubEnv("LLMWIKI_MODEL", undefined);
    stubEnv("LLMWIKI_EMBEDDING_PROVIDER", undefined);
    stubEnv("ORCAROUTER_API_KEY", "gateway-key");
    stubEnv("OPENAI_API_KEY", "unrelated-openai-key");
  });
  afterEach(() => { restoreEnv(); restoreGlobals(); });

  it.each([undefined, "", "   "])("rejects unusable credentials %j in both entry points", (key) => {
    stubEnv("ORCAROUTER_API_KEY", key);
    expect(() => ensureProviderAvailable()).toThrow("ORCAROUTER_API_KEY");
    expect(() => getProvider()).toThrow("ORCAROUTER_API_KEY");
  });

  it.each([undefined, "openai/gpt-4o"])("sends structured requests for model override %j", async (model) => {
    stubEnv("LLMWIKI_MODEL", model);
    stubEnv("ORCAROUTER_API_KEY", "  gateway-key  ");
    stubGlobal("fetch", async (url: string, init: RequestInit) => {
      expect(String(url)).toBe("https://api.orcarouter.ai/v1/chat/completions");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer gateway-key");
      expect(JSON.parse(String(init.body))).toMatchObject({
        model: model ?? "openai/gpt-4o-mini",
        tool_choice: "required",
        tools: [{ type: "function", function: { name: "extract" } }],
      });
      return Response.json({ choices: [{ message: {
        role: "assistant", tool_calls: [{ type: "function", function: {
          name: "extract", arguments: '{"concepts":["gateway"]}',
        } }],
      } }] });
    });
    expect(() => ensureProviderAvailable()).not.toThrow();
    expect(resolveActiveModelId()).toBe(model ?? "openai/gpt-4o-mini");
    const result = await getProvider().toolCall("Extract concepts", [], [{
      name: "extract", description: "Extract", input_schema: { type: "object" },
    }], 100);
    expect(JSON.parse(result)).toEqual({ concepts: ["gateway"] });
  });
});

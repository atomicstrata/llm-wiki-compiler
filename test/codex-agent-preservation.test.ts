/**
 * Preservation witnesses for adding the opt-in Codex provider.
 *
 * These pin the old default and an existing explicit provider while also
 * proving that only the new provider receives stricter embedding treatment.
 */

import { afterEach, describe, expect, it } from "vitest";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { AtlasCloudProvider } from "../src/providers/atlascloud.js";
import { ClaudeAgentProvider } from "../src/providers/claude-agent.js";
import { CopilotProvider } from "../src/providers/copilot.js";
import { MiniMaxProvider } from "../src/providers/minimax.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { OllamaProvider } from "../src/providers/ollama.js";
import { getEmbeddingProvider } from "../src/utils/embedding-provider.js";
import { ensureProviderAvailable } from "../src/utils/provider-guard.js";
import { getProvider } from "../src/utils/provider.js";

const originalEnv = { ...process.env };
afterEach(() => { process.env = { ...originalEnv }; });

describe("codex-agent opt-in preservation", () => {
  it("keeps Anthropic as the default provider", () => {
    delete process.env.LLMWIKI_PROVIDER;
    expect(getProvider()).toBeInstanceOf(AnthropicProvider);
  });

  it("keeps the existing OpenAI selection and key guard unchanged", () => {
    process.env.LLMWIKI_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "existing-openai-key";
    expect(() => ensureProviderAvailable()).not.toThrow();
    expect(getProvider()).toBeInstanceOf(OpenAIProvider);
  });

  it.each([
    ["anthropic", "ANTHROPIC_API_KEY", AnthropicProvider],
    ["claude-agent", "", ClaudeAgentProvider],
    ["openai", "OPENAI_API_KEY", OpenAIProvider],
    ["ollama", "", OllamaProvider],
    ["minimax", "MINIMAX_API_KEY", MiniMaxProvider],
    ["copilot", "GITHUB_TOKEN", CopilotProvider],
    ["atlascloud", "ATLASCLOUD_API_KEY", AtlasCloudProvider],
  ])("keeps the existing %s provider factory behavior", (provider, key, expected) => {
    process.env.LLMWIKI_PROVIDER = provider;
    if (key) process.env[key] = "existing-provider-credential";
    expect(() => ensureProviderAvailable()).not.toThrow();
    expect(getProvider()).toBeInstanceOf(expected);
  });

  it("keeps existing providers' soft default embedding behavior", () => {
    process.env.LLMWIKI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "existing-anthropic-key";
    delete process.env.LLMWIKI_EMBEDDING_PROVIDER;
    delete process.env.VOYAGE_API_KEY;
    expect(() => ensureProviderAvailable()).not.toThrow();
  });

  it("accepts keyless codex chat only with an explicit usable embedding provider", () => {
    process.env.LLMWIKI_PROVIDER = "codex-agent";
    process.env.LLMWIKI_EMBEDDING_PROVIDER = "ollama";
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => ensureProviderAvailable()).not.toThrow();
    expect(getEmbeddingProvider()).toBeInstanceOf(OllamaProvider);
  });

  it("rejects implicit embedding degradation only for codex-agent", () => {
    process.env.LLMWIKI_PROVIDER = "codex-agent";
    delete process.env.LLMWIKI_EMBEDDING_PROVIDER;
    expect(() => ensureProviderAvailable()).toThrow(/LLMWIKI_EMBEDDING_PROVIDER/);
  });
});

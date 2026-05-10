/**
 * Tests for the GitHub Copilot LLM provider.
 * Covers constructor behaviour, factory resolution, and the embed() stub.
 */

import { describe, it, expect, afterEach } from "vitest";
import { CopilotProvider } from "../src/providers/copilot.js";
import { getProvider } from "../src/utils/provider.js";
import { COPILOT_BASE_URL, PROVIDER_MODELS } from "../src/utils/constants.js";

describe("CopilotProvider", () => {
  it("constructs without throwing when given a token and model", () => {
    expect(() => new CopilotProvider("gpt-4o", "ghp_test")).not.toThrow();
  });

  it("uses the Copilot base URL", () => {
    const provider = new CopilotProvider("gpt-4o", "ghp_test");
    const clientBaseURL = Reflect.get(Reflect.get(provider, "client"), "baseURL") as string;
    expect(clientBaseURL).toBe(COPILOT_BASE_URL);
  });

  it("throws on embed() with a helpful message", async () => {
    const provider = new CopilotProvider("gpt-4o", "ghp_test");
    await expect(provider.embed("hello")).rejects.toThrow(
      "GitHub Copilot does not support embeddings",
    );
  });

  it("embed() error message mentions switching to the openai provider", async () => {
    const provider = new CopilotProvider("gpt-4o", "ghp_test");
    await expect(provider.embed("hello")).rejects.toThrow("LLMWIKI_PROVIDER=openai");
  });
});

describe("getProvider with copilot", () => {
  afterEach(() => {
    delete process.env.LLMWIKI_PROVIDER;
    delete process.env.LLMWIKI_MODEL;
    delete process.env.GITHUB_TOKEN;
  });

  it("returns CopilotProvider when LLMWIKI_PROVIDER=copilot", () => {
    process.env.LLMWIKI_PROVIDER = "copilot";
    process.env.GITHUB_TOKEN = "ghp_test";
    const provider = getProvider();
    expect(provider).toBeInstanceOf(CopilotProvider);
  });

  it("throws when GITHUB_TOKEN is absent for copilot provider", () => {
    process.env.LLMWIKI_PROVIDER = "copilot";
    delete process.env.GITHUB_TOKEN;
    expect(() => getProvider()).toThrow("GITHUB_TOKEN");
  });

  it("uses the default copilot model (gpt-4o) when LLMWIKI_MODEL is unset", () => {
    process.env.LLMWIKI_PROVIDER = "copilot";
    process.env.GITHUB_TOKEN = "ghp_test";
    delete process.env.LLMWIKI_MODEL;
    const provider = getProvider();
    expect(Reflect.get(provider, "model")).toBe(PROVIDER_MODELS.copilot);
  });

  it("respects LLMWIKI_MODEL override for copilot provider", () => {
    process.env.LLMWIKI_PROVIDER = "copilot";
    process.env.GITHUB_TOKEN = "ghp_test";
    process.env.LLMWIKI_MODEL = "claude-sonnet-4-5";
    const provider = getProvider();
    expect(Reflect.get(provider, "model")).toBe("claude-sonnet-4-5");
  });
});

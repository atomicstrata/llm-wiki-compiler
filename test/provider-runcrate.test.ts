/**
 * Tests for the Runcrate LLM provider.
 * Covers constructor behavior, the default base URL, and the embed() fail-closed stubs.
 */

import { describe, it, expect } from "vitest";
import { RuncrateProvider } from "../src/providers/runcrate.js";
import { PROVIDER_MODELS, RUNCRATE_BASE_URL } from "../src/utils/constants.js";

describe("RuncrateProvider", () => {
  it("constructs without throwing when given a key and model", () => {
    expect(() => new RuncrateProvider(PROVIDER_MODELS.runcrate, "runcrate-test-key")).not.toThrow();
  });

  it("uses the Runcrate OpenAI-compatible base URL", () => {
    const provider = new RuncrateProvider(PROVIDER_MODELS.runcrate, "runcrate-test-key");
    const clientBaseURL = Reflect.get(Reflect.get(provider, "client"), "baseURL") as string;
    expect(clientBaseURL).toBe(RUNCRATE_BASE_URL);
    expect(RUNCRATE_BASE_URL).toBe("https://api.runcrate.ai/v1");
  });

  it("throws on embed() with a helpful message", async () => {
    const provider = new RuncrateProvider(PROVIDER_MODELS.runcrate, "runcrate-test-key");

    await expect(provider.embed("hello")).rejects.toThrow(
      "Runcrate provider does not support embeddings",
    );
  });

  it("throws on embedBatch() the same way", async () => {
    const provider = new RuncrateProvider(PROVIDER_MODELS.runcrate, "runcrate-test-key");

    await expect(provider.embedBatch(["a", "b"])).rejects.toThrow(
      "Runcrate provider does not support embeddings",
    );
  });
});

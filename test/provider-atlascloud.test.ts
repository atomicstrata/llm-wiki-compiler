/**
 * Tests for the Atlas Cloud LLM provider.
 * Covers constructor behavior, env alias resolution, and the embed() stub.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  AtlasCloudProvider,
  resolveAtlasCloudApiKeyFromEnv,
  resolveAtlasCloudBaseURLFromEnv,
} from "../src/providers/atlascloud.js";
import { ATLASCLOUD_BASE_URL } from "../src/utils/constants.js";

describe("AtlasCloudProvider", () => {
  afterEach(() => {
    delete process.env.ATLASCLOUD_API_KEY;
    delete process.env.ATLAS_CLOUD_API_KEY;
    delete process.env.ATLASCLOUD_BASE_URL;
    delete process.env.ATLAS_CLOUD_BASE_URL;
  });

  it("constructs without throwing when given a key and model", () => {
    expect(() => new AtlasCloudProvider("qwen/qwen3.5-flash", "atlas-test-key")).not.toThrow();
  });

  it("uses the Atlas Cloud OpenAI-compatible base URL by default", () => {
    const provider = new AtlasCloudProvider("qwen/qwen3.5-flash", "atlas-test-key");
    const clientBaseURL = Reflect.get(Reflect.get(provider, "client"), "baseURL") as string;
    expect(clientBaseURL).toBe(ATLASCLOUD_BASE_URL);
  });

  it("resolves ATLASCLOUD_API_KEY before the ATLAS_CLOUD_API_KEY alias", () => {
    process.env.ATLASCLOUD_API_KEY = "primary-key";
    process.env.ATLAS_CLOUD_API_KEY = "alias-key";

    expect(resolveAtlasCloudApiKeyFromEnv()).toBe("primary-key");
  });

  it("falls back to ATLAS_CLOUD_API_KEY when the primary key is absent", () => {
    process.env.ATLAS_CLOUD_API_KEY = "alias-key";

    expect(resolveAtlasCloudApiKeyFromEnv()).toBe("alias-key");
  });

  it("resolves the Atlas Cloud base URL alias", () => {
    process.env.ATLAS_CLOUD_BASE_URL = "https://atlas-proxy.example/v1";

    expect(resolveAtlasCloudBaseURLFromEnv()).toBe("https://atlas-proxy.example/v1");
  });

  it("throws on embed() with a helpful message", async () => {
    const provider = new AtlasCloudProvider("qwen/qwen3.5-flash", "atlas-test-key");

    await expect(provider.embed("hello")).rejects.toThrow(
      "Atlas Cloud provider does not support embeddings",
    );
  });
});

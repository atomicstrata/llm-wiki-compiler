import { describe, it, expect, afterEach } from "vitest";
import { ensureProviderAvailable, ProviderUnavailableError, UnknownProviderError } from "../../src/utils/provider-guard.js";

describe("ensureProviderAvailable error taxonomy", () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it("throws ProviderUnavailableError with structured fields when creds missing", () => {
    process.env.LLMWIKI_PROVIDER = "anthropic";
    delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN;
    try { ensureProviderAvailable(); throw new Error("did not throw"); }
    catch (e) {
      expect(e).toBeInstanceOf(ProviderUnavailableError);
      const err = e as ProviderUnavailableError;
      expect(err.code).toBe("provider_unavailable");
      expect(err.provider).toBe("anthropic");
      expect(err.missing).toContain("ANTHROPIC_API_KEY");
      expect(err.missing.length).toBeGreaterThan(0);
    }
  });

  it("throws ProviderUnavailableError for a non-anthropic provider missing its key", () => {
    process.env.LLMWIKI_PROVIDER = "openai";
    delete process.env.OPENAI_API_KEY;
    try { ensureProviderAvailable(); throw new Error("did not throw"); }
    catch (e) {
      expect(e).toBeInstanceOf(ProviderUnavailableError);
      const err = e as ProviderUnavailableError;
      expect(err.code).toBe("provider_unavailable");
      expect(err.provider).toBe("openai");
      expect(err.missing).toContain("OPENAI_API_KEY");
    }
  });

  it("throws UnknownProviderError for an unsupported provider", () => {
    process.env.LLMWIKI_PROVIDER = "bogus";
    try { ensureProviderAvailable(); throw new Error("did not throw"); }
    catch (e) {
      expect(e).toBeInstanceOf(UnknownProviderError);
      const err = e as UnknownProviderError;
      expect(err.code).toBe("unknown_provider");
      expect(err.provider).toBe("bogus");
      expect(err.supported).toContain("anthropic");
    }
  });
});

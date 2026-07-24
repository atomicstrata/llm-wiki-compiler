import { describe, it, expect, afterEach } from "vitest";
import { ensureProviderAvailable, ProviderUnavailableError, UnknownProviderError } from "../../src/utils/provider-guard.js";

/** Call ensureProviderAvailable() and return the caught error, or throw if it does not throw. */
function catchGuardError(): unknown {
  try {
    ensureProviderAvailable();
    throw new Error("did not throw");
  } catch (e) {
    return e;
  }
}

/** Assert the error is a ProviderUnavailableError with the given provider and return it. */
function assertUnavailableError(e: unknown, provider: string): ProviderUnavailableError {
  expect(e).toBeInstanceOf(ProviderUnavailableError);
  const err = e as ProviderUnavailableError;
  expect(err.code).toBe("provider_unavailable");
  expect(err.provider).toBe(provider);
  return err;
}

describe("ensureProviderAvailable error taxonomy", () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it("throws ProviderUnavailableError with structured fields when creds missing", () => {
    process.env.LLMWIKI_PROVIDER = "anthropic";
    delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN;
    const err = assertUnavailableError(catchGuardError(), "anthropic");
    expect(err.missing).toContain("ANTHROPIC_API_KEY");
    expect(err.missing.length).toBeGreaterThan(0);
  });

  it("throws ProviderUnavailableError for a non-anthropic provider missing its key", () => {
    process.env.LLMWIKI_PROVIDER = "openai";
    delete process.env.OPENAI_API_KEY;
    const err = assertUnavailableError(catchGuardError(), "openai");
    expect(err.missing).toContain("OPENAI_API_KEY");
  });

  it("throws ProviderUnavailableError with both Atlas Cloud key aliases when missing", () => {
    process.env.LLMWIKI_PROVIDER = "atlas-cloud";
    delete process.env.ATLASCLOUD_API_KEY;
    delete process.env.ATLAS_CLOUD_API_KEY;

    const err = assertUnavailableError(catchGuardError(), "atlascloud");

    expect(err.missing).toContain("ATLASCLOUD_API_KEY");
    expect(err.missing).toContain("ATLAS_CLOUD_API_KEY");
  });

  it("accepts ATLAS_CLOUD_API_KEY for Atlas Cloud provider aliases", () => {
    process.env.LLMWIKI_PROVIDER = "atlas";
    process.env.ATLAS_CLOUD_API_KEY = "atlas-test-key";

    expect(() => ensureProviderAvailable()).not.toThrow();
  });

  it("throws UnknownProviderError for an unsupported provider", () => {
    process.env.LLMWIKI_PROVIDER = "bogus";
    const e = catchGuardError();
    expect(e).toBeInstanceOf(UnknownProviderError);
    const err = e as UnknownProviderError;
    expect(err.code).toBe("unknown_provider");
    expect(err.provider).toBe("bogus");
    expect(err.supported).toContain("anthropic");
  });
});

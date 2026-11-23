/**
 * Tests for callClaude retry behaviour in src/utils/llm.ts.
 *
 * Verifies that non-retriable client errors (401, 403, 400) throw immediately
 * without consuming retry attempts, while retriable errors (429, 5xx, network)
 * are still retried as before.
 *
 * The fake provider is bound only around each call with `runWithProviderOverride`
 * rather than a module mock: Bun keeps a module mock for the rest of the process,
 * so a mocked provider here used to answer later test files' model calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "bun:test";
import { callClaude, computeBackoffMs } from "../src/utils/llm.js";
import { runWithProviderOverride, type LLMProvider } from "../src/utils/provider.js";
import { RETRY_BASE_MS, RETRY_MULTIPLIER } from "../src/utils/constants.js";

const mockComplete = vi.fn();

/** A deterministic provider whose chat calls all reach `mockComplete`; embeddings are unused. */
const STUB_PROVIDER: LLMProvider = {
  complete: mockComplete,
  stream: mockComplete,
  toolCall: mockComplete,
  embed: async () => [],
};

const BASE_OPTIONS = {
  system: "s",
  messages: [{ role: "user" as const, content: "q" }],
};

/** `callClaude(BASE_OPTIONS)` with the stub provider bound to this one call tree only. */
function callWithStubProvider(): Promise<string> {
  return runWithProviderOverride(
    { provider: STUB_PROVIDER, providerName: "offline", modelId: "retry-test" },
    () => callClaude(BASE_OPTIONS),
  );
}

describe("computeBackoffMs jitter", () => {
  const baseFor = (attempt: number) => RETRY_BASE_MS * Math.pow(RETRY_MULTIPLIER, attempt);

  it("keeps each attempt's delay within [base/2, base]", () => {
    for (const attempt of [0, 1, 2]) {
      for (let i = 0; i < 25; i++) {
        const delay = computeBackoffMs(attempt);
        expect(delay).toBeGreaterThanOrEqual(baseFor(attempt) / 2);
        expect(delay).toBeLessThanOrEqual(baseFor(attempt));
      }
    }
  });

  it("jitters so concurrent retries do not fire in lockstep", () => {
    const samples = new Set(Array.from({ length: 40 }, () => computeBackoffMs(1)));
    expect(samples.size).toBeGreaterThan(1);
  });
});

describe("callClaude non-retriable errors", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockComplete.mockReset();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("throws immediately on 401 without retrying", async () => {
    mockComplete.mockRejectedValue(
      new Error('401 {"error":{"type":"authentication_error","message":"invalid x-api-key"}}'),
    );

    await expect(callWithStubProvider()).rejects.toThrow("401");
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("throws immediately on 403 without retrying", async () => {
    mockComplete.mockRejectedValue(new Error("403 forbidden"));

    await expect(callWithStubProvider()).rejects.toThrow("403");
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("throws immediately on 400 bad request without retrying", async () => {
    mockComplete.mockRejectedValue(new Error("400 bad_request_error"));

    await expect(callWithStubProvider()).rejects.toThrow("400");
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

});

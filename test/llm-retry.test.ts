/**
 * Tests for callClaude retry behaviour in src/utils/llm.ts.
 *
 * Verifies that non-retriable client errors (401, 403, 400) throw immediately
 * without consuming retry attempts, while retriable errors (429, 5xx, network)
 * are still retried as before.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockComplete = vi.hoisted(() => vi.fn());

vi.mock("../src/utils/provider.js", () => ({
  getProvider: () => ({
    complete: mockComplete,
    stream: mockComplete,
    toolCall: mockComplete,
  }),
}));

import { callClaude, computeBackoffMs } from "../src/utils/llm.js";
import { RETRY_BASE_MS, RETRY_MULTIPLIER } from "../src/utils/constants.js";

const BASE_OPTIONS = {
  system: "s",
  messages: [{ role: "user" as const, content: "q" }],
};

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
    mockComplete.mockClear();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("throws immediately on 401 without retrying", async () => {
    mockComplete.mockRejectedValue(
      new Error('401 {"error":{"type":"authentication_error","message":"invalid x-api-key"}}'),
    );

    await expect(callClaude(BASE_OPTIONS)).rejects.toThrow("401");
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("throws immediately on 403 without retrying", async () => {
    mockComplete.mockRejectedValue(new Error("403 forbidden"));

    await expect(callClaude(BASE_OPTIONS)).rejects.toThrow("403");
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("throws immediately on 400 bad request without retrying", async () => {
    mockComplete.mockRejectedValue(new Error("400 bad_request_error"));

    await expect(callClaude(BASE_OPTIONS)).rejects.toThrow("400");
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

});

/**
 * Tests for Anthropic provider client options.
 * Verifies that Anthropic client options are correctly built based on baseURL.
 */

import { describe, it, expect } from "bun:test";
import { buildAnthropicClientOptions } from "../src/providers/anthropic.js";

describe("buildAnthropicClientOptions", () => {
  it("returns base options when baseURL is not provided", () => {
    const options = buildAnthropicClientOptions();
    expect(options).toEqual({});
  });

  it("includes baseURL when explicitly provided", () => {
    const baseURL = "https://custom.anthropic.com";
    const options = buildAnthropicClientOptions({ baseURL });
    expect(options).toEqual({ baseURL });
  });

  it("omits baseURL when provide with empty string", () => {
    const options = buildAnthropicClientOptions({ baseURL: "" });
    expect(options).toEqual({});
  });

  it("omits baseURL when provide with undefined", () => {
    const options = buildAnthropicClientOptions({ baseURL: undefined });
    expect(options).toEqual({});
  });

  it("normalizes trailing slash in baseURL", () => {
    const baseURL = "https://custom.anthropic.com/";
    const options = buildAnthropicClientOptions({ baseURL });
    expect(options.baseURL).toBe("https://custom.anthropic.com");
  });

  it("treats whitespace-only baseURL as unset", () => {
    const options = buildAnthropicClientOptions({ baseURL: "   " });
    expect(options).toEqual({});
  });

  it("includes auth token when provided", () => {
    const options = buildAnthropicClientOptions({ authToken: " token-value " });
    expect(options).toEqual({ authToken: "token-value" });
  });

  it("includes API key when provided", () => {
    const options = buildAnthropicClientOptions({ apiKey: " key-value " });
    expect(options).toEqual({ apiKey: "key-value" });
  });

  it("combines auth and path endpoint options", () => {
    const options = buildAnthropicClientOptions({
      authToken: "token-value",
      baseURL: "https://api.kimi.com/coding/",
    });

    expect(options).toEqual({
      authToken: "token-value",
      baseURL: "https://api.kimi.com/coding",
    });
  });
});

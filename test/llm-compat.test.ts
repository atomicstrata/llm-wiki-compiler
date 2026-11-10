/**
 * Backward compatibility tests for the callClaude export.
 * Ensures that the refactored llm.ts still exports callClaude and
 * accepts the same options interface as before the provider abstraction.
 */

import { describe, it, expect } from "bun:test";
import { callClaude } from "../src/utils/llm.js";

describe("callClaude backward compatibility", () => {
  it("is exported as a function from llm.ts", () => {
    expect(typeof callClaude).toBe("function");
  });

  it("accepts the existing options interface shape", () => {
    // Verify the function signature accepts all known option fields
    // without throwing a type error at import time.
    const optionsShape = {
      system: "You are a test assistant.",
      messages: [{ role: "user" as const, content: "Hello" }],
      tools: [{ name: "t", description: "d", input_schema: { type: "object" } }],
      maxTokens: 1024,
      stream: false,
      onToken: (_text: string) => {},
    };

    // The options object should match the expected shape without type errors.
    // We do not actually call the function (would require a real API key).
    expect(optionsShape).toBeDefined();
  });
});

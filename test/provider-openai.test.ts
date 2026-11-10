/**
 * Tests for OpenAI tool schema translation.
 * Verifies that Anthropic-style tool schemas (input_schema) are correctly
 * converted to OpenAI format (parameters).
 */

import { describe, it, expect } from "bun:test";
import { translateToolToOpenAI } from "../src/providers/openai.js";
import type { LLMTool } from "../src/utils/provider.js";

describe("translateToolToOpenAI", () => {
  it("translates input_schema to parameters", () => {
    const tool: LLMTool = {
      name: "get_weather",
      description: "Get the weather for a city",
      input_schema: {
        type: "object",
        properties: {
          city: { type: "string", description: "City name" },
        },
        required: ["city"],
      },
    };

    const result = translateToolToOpenAI(tool);

    expect(result.type).toBe("function");
    expect(result.function.name).toBe("get_weather");
    expect(result.function.description).toBe("Get the weather for a city");
    expect(result.function.parameters).toEqual(tool.input_schema);
  });

  it("preserves required fields through translation", () => {
    const tool: LLMTool = {
      name: "search",
      description: "Search documents",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
        },
        required: ["query"],
      },
    };

    const result = translateToolToOpenAI(tool);
    const params = result.function.parameters as Record<string, unknown>;
    expect(params.required).toEqual(["query"]);
  });

  it("translates multiple tools correctly", () => {
    const tools: LLMTool[] = [
      {
        name: "tool_a",
        description: "First tool",
        input_schema: { type: "object", properties: { x: { type: "string" } } },
      },
      {
        name: "tool_b",
        description: "Second tool",
        input_schema: { type: "object", properties: { y: { type: "number" } } },
      },
    ];

    const results = tools.map(translateToolToOpenAI);

    expect(results).toHaveLength(2);
    expect(results[0].function.name).toBe("tool_a");
    expect(results[1].function.name).toBe("tool_b");
    expect(results[0].function.parameters).toEqual(tools[0].input_schema);
    expect(results[1].function.parameters).toEqual(tools[1].input_schema);
  });
});

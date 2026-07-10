/**
 * LLM-driven wiki page selection.
 *
 * Exposes {@link selectPages}, which asks the model (via a provider-agnostic
 * `tool_use` schema) to pick the most relevant wiki pages for a question from a
 * rendered index. Extracted from `commands/query.ts` so the search-retrieval
 * pipeline can reuse it WITHOUT importing the query command module — that import
 * direction closed a `query.ts ⇄ retrieval.ts` cycle once the query path began
 * hydrating answers through the retrieval module's `loadSelectedRefs`.
 */

import { callClaude } from "../utils/llm.js";
import type { LLMTool } from "../utils/provider.js";
import { QUERY_PAGE_LIMIT } from "../utils/constants.js";

/** Tool schema for page selection (provider-agnostic). */
const PAGE_SELECTION_TOOL: LLMTool = {
  name: "select_pages",
  description: "Select the most relevant wiki pages to answer a question",
  input_schema: {
    type: "object" as const,
    properties: {
      pages: {
        type: "array",
        items: {
          type: "string",
          description: "Qualified page id of a relevant wiki page (e.g. 'concepts/llm-knowledge-bases')",
        },
        maxItems: QUERY_PAGE_LIMIT,
      },
      reasoning: {
        type: "string",
        description: "Brief explanation of why these pages were selected",
      },
    },
    required: ["pages", "reasoning"],
  },
};

/** Parsed result of an LLM page-selection call. */
export interface PageSelectionResult {
  pages: string[];
  reasoning: string;
}

/**
 * Select the most relevant wiki pages for a question using Claude tool_use.
 * @param question - The user's natural language question.
 * @param indexContent - The full text of wiki/index.md (or a filtered index).
 * @returns Parsed page slugs and reasoning from the model.
 */
export async function selectPages(
  question: string,
  indexContent: string,
): Promise<PageSelectionResult> {
  const systemPrompt =
    "You are a knowledge base assistant. Given a question and a wiki index, select the most relevant pages.";

  const userMessage = `Question: ${question}\n\nWiki Index:\n${indexContent}`;

  const rawResult = await callClaude({
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    tools: [PAGE_SELECTION_TOOL],
  });

  try {
    const parsed = JSON.parse(rawResult);
    return {
      pages: Array.isArray(parsed.pages) ? parsed.pages.filter((p: unknown) => typeof p === "string") : [],
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "No reasoning provided",
    };
  } catch {
    return { pages: [], reasoning: "Failed to parse page selection response" };
  }
}

/**
 * Shared provider boundary stubs for owner-closure compile tests.
 *
 * The tests supply only the source-to-concepts resolver; this helper owns the
 * repeated Anthropic and embeddings seams used by the real compile pipeline.
 */

import { vi } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic.js";
import * as embeddings from "../../src/utils/embeddings.js";

/** Build a provider-compatible extraction response. */
export function conceptResponse(...names: string[]): string {
  return JSON.stringify({
    concepts: names.map((concept) => ({
      concept,
      summary: `${concept} summary.`,
      is_new: false,
    })),
  });
}

/**
 * Stub external model calls and capture every extraction system prompt.
 * @param resolveExtraction - Maps one extraction system prompt to tool JSON.
 * @returns Mutable prompt capture that callers can clear between compile runs.
 */
export function stubOwnerClosureProvider(
  resolveExtraction: (system: string) => string,
): string[] {
  const systems: string[] = [];
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockImplementation(async (system) => {
    systems.push(system);
    return resolveExtraction(system);
  });
  vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue("Generated page.");
  vi.spyOn(embeddings, "updateEmbeddingsLockedCore")
    .mockResolvedValue({ embedded: [], eligible: [] });
  vi.spyOn(console, "log").mockImplementation(() => {});
  return systems;
}

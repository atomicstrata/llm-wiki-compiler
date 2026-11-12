/**
 * Shared on-disk project setup for reconciliation regression tests.
 * These tests exercise ownership and retry state, not embedding providers or
 * progress output. Keep those two side effects stubbed consistently while each
 * suite controls its own extraction and page-generation responses.
 */
import { beforeEach, vi } from "bun:test";
import { AnthropicProvider } from "../../src/providers/anthropic.js";
import * as embeddings from "../../src/utils/embeddings.js";
import { useCompileProject, type CompileProjectCtx, type CompileProjectOptions } from "./compile-project.js";

/** Register the standard project lifecycle and isolate unrelated side effects. */
export function useReconciliationProject(options: CompileProjectOptions): CompileProjectCtx {
  const ctx = useCompileProject(options);
  beforeEach(() => {
    vi.spyOn(embeddings, "updateEmbeddingsLockedCoreFrom").mockResolvedValue({ embedded: [], eligible: [], pruned: [] });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  return ctx;
}

/** Let each regression control extraction and generation independently. */
export function mockReconciliationProvider() {
  return {
    toolCall: vi.spyOn(AnthropicProvider.prototype, "toolCall"),
    complete: vi.spyOn(AnthropicProvider.prototype, "complete"),
  };
}

/**
 * A provider whose extraction gives each source the shared concept plus its own
 * private concept, named after the first of `names` found in the source text.
 */
export function mockSharedConceptProvider(names: readonly string[], fallback = "Other") {
  const provider = mockReconciliationProvider();
  provider.toolCall.mockImplementation(async (system) => {
    const source = system.split("--- SOURCE DOCUMENT ---")[1];
    const name = names.find((candidate) => source.includes(candidate)) ?? fallback;
    return JSON.stringify({ concepts: ["Shared", name].map((concept) => ({
      concept, summary: `${name} supports ${concept}`, is_new: true, confidence: 0.8,
    })) });
  });
  provider.complete.mockResolvedValue("Supported content about the shared subject.");
  return provider;
}

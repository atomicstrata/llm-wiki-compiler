/**
 * Shared on-disk project setup for reconciliation regression tests.
 * These tests exercise ownership and retry state, not embedding providers or
 * progress output. Keep those two side effects stubbed consistently while each
 * suite controls its own extraction and page-generation responses.
 */
import { beforeEach, vi } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic.js";
import * as embeddings from "../../src/utils/embeddings.js";
import { useCompileProject, type CompileProjectCtx, type CompileProjectOptions } from "./compile-project.js";

/** Register the standard project lifecycle and isolate unrelated side effects. */
export function useReconciliationProject(options: CompileProjectOptions): CompileProjectCtx {
  const ctx = useCompileProject(options);
  beforeEach(() => {
    vi.spyOn(embeddings, "updateEmbeddingsLockedCore").mockResolvedValue({ embedded: [], eligible: [] });
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

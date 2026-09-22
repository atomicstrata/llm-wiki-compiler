/**
 * Standard synchronous SDK composition. Knowledge services remain usable without
 * local workflow execution; this facade preserves both for existing consumers.
 * Normalize the root once and pass the original options without copying grants.
 */
import path from "node:path";
import { withQuiet, createWikiCoreAtRoot } from "@atomicstrata/llmwiki-core/compiler-sdk";
import { buildWorkflowFacade } from "./workflow-facade.js";
import type { CreateWikiOptions, Wiki } from "./types.js";

/** Preserve rejected-promise behavior for synchronous delegate failures. */
async function runQuiet<T>(fn: () => Promise<T>): Promise<T> {
  return withQuiet(fn);
}

/** Create the standard knowledge-plus-local-workflows facade synchronously. */
export function createWiki(options: CreateWikiOptions): Wiki {
  const root = path.resolve(options.root);
  return {
    ...createWikiCoreAtRoot(root, options),
    ...buildWorkflowFacade(root, runQuiet),
  };
}

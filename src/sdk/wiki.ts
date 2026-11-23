/**
 * Standard synchronous SDK composition. Knowledge services remain usable without
 * local workflow execution; this facade preserves both for existing consumers.
 * Normalize the root once and pass the original options without copying grants.
 */
import path from "node:path";
import { withQuiet, createWikiCoreAtRoot, initProjectAtRoot } from "@atomicstrata/llmwiki-core/compiler-sdk";
import { buildWorkflowFacade } from "./workflow-facade.js";
import type { CreateWikiOptions, InitWikiOptions, Wiki } from "./types.js";

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

/**
 * Create the local project at `options.root`, prove its setup usable, record
 * and prepare `options.expectedScale` when given, then return the standard
 * facade. Async because it persists; `createWiki` stays synchronous and does
 * no I/O. Check `wiki.scale.status()` for a parked or unavailable estimate.
 */
export async function initWiki(options: InitWikiOptions): Promise<Wiki> {
  await runQuiet(() => initProjectAtRoot(path.resolve(options.root), options.expectedScale));
  return createWiki(options);
}

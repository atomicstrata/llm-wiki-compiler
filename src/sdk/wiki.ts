/**
 * @file src/sdk/wiki.ts
 * @description In-process SDK facade for llmwiki.
 *
 * `createWiki(options)` returns a `Wiki` object that delegates every
 * method to the SDK-safe core functions built across Tasks 1–9. All
 * methods run silently (no console output) by temporarily forcing the
 * shared quiet flag, restoring the caller's prior value on exit.
 *
 * Provider-gating rules:
 *   - `compile`, `search`, `query` — always guard (throw ProviderUnavailableError if no creds)
 *   - `runEval({ mode: "full" })` — guards only when mode is "full"
 *   - All other methods — no credential check; safe to call without an LLM provider
 *
 * The root path is normalized once via `path.resolve` so every downstream
 * call works from an absolute path regardless of the caller's cwd.
 */

import path from "path";
import { setQuiet, getQuiet } from "../utils/output.js";
import { ingestSource, ingestTextSource } from "../commands/ingest.js";
import { compileAndReport } from "../compiler/index.js";
import { generateAnswer } from "../commands/query.js";
import { lint } from "../linter/index.js";
import { buildContextPack } from "../context/build.js";
import { exportJson } from "../commands/export.js";
import { runEval, DEFAULT_SAMPLE_SIZE } from "../eval/index.js";
import { ensureProviderAvailable } from "../utils/provider-guard.js";
import { collectStatus } from "../status/collect.js";
import { pickSearchSlugs, loadPageRecords } from "../search/retrieval.js";
import { getPage, listPages } from "../pages/list.js";
import type { CreateWikiOptions, Wiki, SdkCompileOptions } from "./types.js";

/**
 * Run `fn` with output forced quiet, restoring the prior flag on exit.
 * Never force-false: if the caller already had quiet=false, that state
 * is restored after `fn` completes.
 */
async function runQuiet<T>(fn: () => Promise<T>): Promise<T> {
  const prev = getQuiet();
  setQuiet(true);
  try {
    return await fn();
  } finally {
    setQuiet(prev);
  }
}

/**
 * Create an in-process wiki facade bound to the given project root.
 *
 * @param options - `{ root }` — path to the wiki project directory.
 * @returns A `Wiki` facade whose methods delegate to the SDK-safe core.
 */
export function createWiki(options: CreateWikiOptions): Wiki {
  // Normalize once so every delegated call works from an absolute path,
  // independent of any subsequent cwd changes in the calling process.
  const root = path.resolve(options.root);

  return {
    ingest: ({ source }) => runQuiet(() => ingestSource(root, source)),

    ingestText: (input) => runQuiet(() => ingestTextSource(root, input)),

    compile: (opts: SdkCompileOptions = {}) =>
      runQuiet(() => {
        ensureProviderAvailable();
        return compileAndReport(root, opts);
      }),

    search: (question) =>
      runQuiet(async () => {
        ensureProviderAvailable();
        const slugs = await pickSearchSlugs(root, question);
        return loadPageRecords(root, slugs);
      }),

    query: (question, opts = {}) =>
      runQuiet(() => {
        ensureProviderAvailable();
        return generateAnswer(root, question, opts);
      }),

    getPage: (ref) => runQuiet(() => getPage(root, ref)),

    listPages: (opts) => runQuiet(() => listPages(root, opts)),

    status: () => runQuiet(() => collectStatus(root)),

    lint: () => runQuiet(() => lint(root)),

    // buildContextPack uses `prompt`/`budget` field names (NOT question/tokenBudget).
    // Semantic retrieval is opportunistic: falls back to lexical when no embeddings
    // are available, so no credential guard is needed here.
    getContextPack: (opts) =>
      runQuiet(() =>
        buildContextPack({
          root,
          prompt: opts.prompt,
          ...(opts.budget !== undefined && { budget: opts.budget }),
          ...(opts.depth !== undefined && { depth: opts.depth }),
          ...(opts.topPages !== undefined && { topPages: opts.topPages }),
          ...(opts.topChunks !== undefined && { topChunks: opts.topChunks }),
        }),
      ),

    exportJson: (opts = {}) => runQuiet(() => exportJson(root, opts)),

    // "full" mode calls the LLM judge; "fast" mode is credential-free.
    runEval: ({ mode, record = false }) =>
      runQuiet(() => {
        if (mode === "full") ensureProviderAvailable();
        return runEval(root, mode, DEFAULT_SAMPLE_SIZE, record);
      }),
  };
}

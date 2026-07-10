/**
 * @file src/sdk/wiki.ts
 * @description In-process SDK facade for llmwiki.
 *
 * `createWiki(options)` returns a `Wiki` object that delegates every
 * method to the SDK-safe core functions built across Tasks 1–9. All
 * methods run silently (no console output) by scoping quiet mode to the
 * async call tree via AsyncLocalStorage, so concurrent calls are fully
 * isolated — no global flag is mutated, eliminating the concurrency caveat
 * described in earlier design drafts.
 *
 * Provider-gating rules:
 *   - `compile`, `search`, `query` — always guard (throw ProviderUnavailableError if no creds)
 *   - `runEval({ mode: "full" })` — guards only when mode is "full"
 *   - All other methods — no credential check; safe to call without an LLM provider
 *
 * Root-path validation: `createWiki` normalizes the root once via `path.resolve`.
 * A non-existent root is accepted — `ingest`/`ingestText` create `sources/` via
 * recursive `mkdir` on first write. If the path already exists but is NOT a
 * directory (e.g. a regular file was passed by mistake), construction throws
 * immediately with a clear error message.
 */

import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { withQuiet } from "../utils/output.js";
import { ingestSource, ingestTextSource } from "../commands/ingest.js";
import { compileAndReport } from "../compiler/index.js";
import { generateAnswer } from "../commands/query.js";
import { lint } from "../linter/index.js";
import { buildContextPack } from "../context/build.js";
import { exportJson } from "../commands/export.js";
import { runEval, DEFAULT_SAMPLE_SIZE } from "../eval/index.js";
import { ensureProviderAvailable } from "../utils/provider-guard.js";
import { collectStatus } from "../status/collect.js";
import { pickSearchRefs, loadSelectedRefs } from "../search/retrieval.js";
import { getPage, listPages } from "../pages/list.js";
import { listSources, getSource, deleteSource } from "../sources/store.js";
import { runOkfExport } from "../export/okf/run.js";
import { runOkfImport } from "../import/run.js";
import { buildStagingFacade } from "./staging-facade.js";
import { buildWorkflowFacade } from "./workflow-facade.js";
import { applyApprovedMutations } from "../trust/executor.js";
import { loadNonDefaultProfile } from "../profile/block.js";
import { resolveArtifactRef, declaresArtifactTypes, ArtifactVerifyUnavailableError, type ArtifactHealth } from "../artifacts/resolve.js";
import type { ArtifactPlannedMutation } from "../trust/planner.js";
import type { CreateWikiOptions, Wiki, SdkCompileOptions } from "./types.js";

/**
 * Run `fn` with output scoped quiet via AsyncLocalStorage.
 * Concurrent calls are fully isolated — no global flag is mutated.
 * Declared async so synchronous throws inside `fn` become rejected promises.
 */
async function runQuiet<T>(fn: () => Promise<T>): Promise<T> {
  return withQuiet(fn);
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

  // A missing root is valid — ingest/ingestText create sources/ via recursive mkdir.
  // But if the path already exists and is NOT a directory, it is always a caller mistake.
  if (existsSync(root) && !statSync(root).isDirectory()) {
    throw new Error(`createWiki: root exists but is not a directory: ${root}`);
  }

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
        const { refs, warnings } = await pickSearchRefs(root, question);
        const pages = await loadSelectedRefs(root, refs);
        return { pages, refs, warnings };
      }),

    query: (question, opts = {}) =>
      runQuiet(() => {
        ensureProviderAvailable();
        return generateAnswer(root, question, opts);
      }),

    getPage: (ref) => runQuiet(() => getPage(root, ref)),

    listPages: (opts) => runQuiet(() => listPages(root, opts)),

    listSources: (opts) => runQuiet(() => listSources(root, opts)),

    getSource: (id) => runQuiet(() => getSource(root, id)),

    deleteSource: (id) => runQuiet(() => deleteSource(root, id)),

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

    exportOkf: (opts = {}) => runQuiet(() => runOkfExport(root, opts)),

    importOkf: (dir, opts = {}) => runQuiet(() => runOkfImport(root, dir, opts)),

    // @experimental artifact write/verify slice — writeArtifact delegates to the
    // SAME self-locking executor seam the CLI uses, threading `origin: "sdk"`
    // from the mutation (never hardcoded downstream); verifyArtifact loads the
    // active non-default profile itself and throws the typed
    // ArtifactVerifyUnavailableError when none is active OR it declares no
    // artifact types (the CLI's dedicated "no artifact types declared" exit,
    // mirrored via the shared `declaresArtifactTypes` predicate so the two
    // surfaces agree), matching the other experimental profile-gated methods.
    //
    // Allowlist-construct the mutation from ONLY the known `input` fields —
    // the SDK is a published JS runtime surface, so a caller can pass extra
    // properties (e.g. a forged `origin`/`kind`) that TypeScript can't stop at
    // the call site. Naming each field (rather than spreading `input`) means no
    // caller-injected property can ride along and override the SDK-stamped
    // `origin` or `kind`.
    writeArtifact: (input) =>
      runQuiet(async () => {
        const mutation: ArtifactPlannedMutation = {
          kind: "artifact",
          artifactType: input.artifactType,
          slug: input.slug,
          body: input.body,
          origin: "sdk",
        };
        const [result] = await applyApprovedMutations(root, [mutation]);
        if (result.kind !== "artifact") throw new Error("executor returned a non-artifact result for an artifact write");
        return { ref: result.ref };
      }),

    // `resolveArtifactRef` also returns the parsed manifest now (an MCP-only
    // optimization — see `src/mcp/tools.ts`); project it away here rather than
    // returning the resolve result verbatim, so the published SDK contract
    // stays exactly `{ health }` and never leaks manifest fields.
    verifyArtifact: (ref): Promise<{ health: ArtifactHealth }> =>
      runQuiet(async () => {
        const loaded = await loadNonDefaultProfile(root);
        if (!loaded) throw new ArtifactVerifyUnavailableError("no-profile", "the project has no non-default profile");
        if (!declaresArtifactTypes(loaded.profile)) {
          throw new ArtifactVerifyUnavailableError("no-artifact-types", "no artifact types declared by the active profile");
        }
        const { health } = await resolveArtifactRef(root, loaded.profile, ref);
        return { health };
      }),

    // @experimental non-default staging slice — factored into staging-facade.ts.
    ...buildStagingFacade(root, runQuiet),

    // @experimental workflow slice — factored into workflow-facade.ts.
    ...buildWorkflowFacade(root, runQuiet),
  };
}

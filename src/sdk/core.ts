/**
 * @file src/sdk/core.ts
 * @description In-process SDK facade for llmwiki.
 *
 * `createWikiCore(options)` returns a `WikiCore` object that delegates every
 * method to the SDK-safe core functions built across Tasks 1–9. All
 * methods run silently (no console output) by scoping quiet mode to the
 * async call tree via AsyncLocalStorage, so concurrent calls are fully
 * isolated — no global flag is mutated, eliminating the concurrency caveat
 * described in earlier design drafts.
 *
 * Provider-gating rules:
 *   - `compile` — guard chat plus embeddings unless refreshes are disabled
 *   - `search`, `query` — always guard (throw ProviderUnavailableError if no creds)
 *   - `runEval({ mode: "full" })` — guards only when mode is "full"
 *   - All other methods — no credential check; safe to call without an LLM provider
 *
 * Root-path validation: `createWikiCore` normalizes the root once via `path.resolve`.
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
import { lint, lintByTier } from "../linter/index.js";
import { buildContextPack } from "../context/build.js";
import { exportJson } from "../commands/export.js";
import { runEval, DEFAULT_SAMPLE_SIZE } from "../eval/index.js";
import {
  ensureCompileProviderAvailable,
  ensureProviderAvailable,
} from "../utils/provider-guard.js";
import { collectStatus } from "../status/collect.js";
import { pickSearchRefs, loadSelectedRefs } from "../search/retrieval.js";
import { getPage, listPages } from "../pages/list.js";
import { listSources, getSource, deleteSource } from "../sources/store.js";
import { runOkfExport } from "../export/okf/run.js";
import { runOkfImport } from "../import/run.js";
import { buildStagingFacade } from "./staging-facade.js";
import { buildPreparationFacade } from "./preparation-facade.js";
import { buildProductFacade } from "./product-facade.js";
import { buildOperationsFacade } from "./operations-facade.js";
import { applyApprovedMutations } from "../trust/executor.js";
import { loadNonDefaultProfile } from "../profile/block.js";
import { resolveArtifactRef, declaresArtifactTypes, ArtifactVerifyUnavailableError, type ArtifactHealth } from "../artifacts/resolve.js";
import type { ArtifactPlannedMutation } from "../trust/planner.js";
import type { CreateWikiOptions, WikiCore, SdkCompileOptions } from "./core-types.js";
import { readVerifiedArtifactBody } from "../artifacts/read-verified.js";
import { captureArtifactSelector, discoverArtifact } from "../artifacts/discover.js";

/** Share the active-profile admission across artifact read surfaces. */
async function requireArtifactProfile(root: string) {
  const loaded = await loadNonDefaultProfile(root);
  if (!loaded) throw new ArtifactVerifyUnavailableError("no-profile", "the project has no non-default profile");
  if (!declaresArtifactTypes(loaded.profile)) {
    throw new ArtifactVerifyUnavailableError("no-artifact-types", "no artifact types declared by the active profile");
  }
  return loaded.profile;
}

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
 * @returns A `WikiCore` facade without local workflow execution methods.
 */
export function createWikiCore(options: CreateWikiOptions): WikiCore {
  return createWikiCoreAtRoot(path.resolve(options.root), options);
}

/** Assemble core at a root already normalized by the standard facade. */
export function createWikiCoreAtRoot(root: string, options: CreateWikiOptions): WikiCore {
  // A missing root is valid — ingest/ingestText create sources/ via recursive mkdir.
  // But if the path already exists and is NOT a directory, it is always a caller mistake.
  if (existsSync(root) && !statSync(root).isDirectory()) {
    throw new Error(`createWiki: root exists but is not a directory: ${root}`);
  }

  return {
    operations: buildOperationsFacade(root, runQuiet, options),
    ingest: ({ source }) => runQuiet(() => ingestSource(root, source)),

    ingestText: (input) => runQuiet(() => ingestTextSource(root, input)),

    compile: (opts: SdkCompileOptions = {}) =>
      runQuiet(() => {
        ensureCompileProviderAvailable(opts.embeddings !== false);
        return compileAndReport(root, opts);
      }),

    search: (question, opts = {}) =>
      runQuiet(async () => {
        ensureProviderAvailable();
        const { refs, warnings } = await pickSearchRefs(root, question, opts);
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

    lintByTier: () => runQuiet(() => lintByTier(root)),

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
    writeArtifact: (input) => {
      // EXACTLY one of body/memberFiles: neither would synthesize an empty
      // body, and BOTH would silently discard the caller's body — a JS caller
      // can pass either shape, so the contract is enforced at runtime.
      if ((input.body === undefined) === (input.memberFiles === undefined)) {
        return Promise.reject(new Error("writeArtifact requires exactly one of body or memberFiles"));
      }
      // SNAPSHOT SYNCHRONOUSLY, before the first await: member bytes are
      // caller-owned mutable views, and hashing one snapshot while writing
      // another would be a forged-manifest channel. Copying here (and again at
      // the executor for non-SDK callers) pins hash === written bytes.
      const mutation: ArtifactPlannedMutation = {
        kind: "artifact",
        artifactType: input.artifactType,
        slug: input.slug,
        // A member-bearing write carries an EMPTY body: core derives the manifest.
        body: input.memberFiles === undefined ? (input.body as string) : "",
        ...(input.memberFiles === undefined ? {} : {
          memberFiles: input.memberFiles.map((file) => ({ fileName: file.fileName, bytes: Uint8Array.from(file.bytes) })),
        }),
        origin: "sdk",
      };
      return runQuiet(async () => {
        const [result] = await applyApprovedMutations(root, [mutation]);
        if (result.kind !== "artifact") throw new Error("executor returned a non-artifact result for an artifact write");
        return { ref: result.ref };
      });
    },

    // `resolveArtifactRef` also returns the parsed manifest now (an MCP-only
    // optimization — see `src/mcp/tools.ts`); project it away here rather than
    // returning the resolve result verbatim, so the published SDK contract
    // stays exactly `{ health }` and never leaks manifest fields.
    verifyArtifact: (ref): Promise<{ health: ArtifactHealth }> =>
      runQuiet(async () => {
        const { health } = await resolveArtifactRef(root, await requireArtifactProfile(root), ref);
        return { health };
      }),

    readVerifiedArtifactBody: (ref) => runQuiet(async () =>
      readVerifiedArtifactBody(root, await requireArtifactProfile(root), ref)),

    discoverArtifact: (selector) => runQuiet(async () => {
      const captured = captureArtifactSelector(selector);
      return discoverArtifact(root, await requireArtifactProfile(root), captured);
    }),

    // @experimental non-default staging slice — factored into staging-facade.ts.
    ...buildStagingFacade(root, runQuiet),

    // @experimental preparation slice — factored into preparation-facade.ts.
    // The embedder's preparation identity and grants are read HERE, at
    // construction, and never from a method argument: an `sdk` principal holds
    // exactly the grants it was given, so an embedder that names none can read
    // preparations and not mutate them.
    //
    // `Object.hasOwn`, not `options.preparation`. The plain read walks the
    // prototype chain, so with `Object.prototype.preparation` planted a caller
    // who passed `{ root }` alone was handed a full grant set — the fail-closed
    // default silently inverted. Own-property only, so an absent option is
    // absent.
    ...buildPreparationFacade(
      root, runQuiet,
      Object.hasOwn(options, "preparation") ? options.preparation : undefined,
    ),

    // @experimental product slice — factored into product-facade.ts. It reads
    // the SAME own-property preparation options the preparation facade does,
    // and for the same reason: `product.invoke` stages and drives a durable
    // preparation, so it must cost the `preparation.run` grant staging costs.
    // An embedder that named none can preview a product action and not run one.
    ...buildProductFacade(
      root, runQuiet,
      Object.hasOwn(options, "preparation") ? options.preparation : undefined,
    ),
  };
}

/**
 * MCP tool registrations for llmwiki.
 *
 * Each tool wraps an existing pipeline function (ingest, compile, query,
 * search, read, lint, status, context-pack, eval) and converts its structured result into
 * an MCP CallToolResult. Tools that need an LLM provider validate the
 * provider lazily — the server itself starts without credentials so
 * read-only tools always work.
 */

import path from "path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ingestSource } from "../commands/ingest.js";
import { compileAndReport } from "../compiler/index.js";
import { generateAnswer, selectPages } from "../commands/query.js";
import { lint } from "../linter/index.js";
import { collectPageSummaries, scanWikiPages } from "../compiler/indexgen.js";
import { detectChanges } from "../compiler/hasher.js";
import { countCandidates } from "../compiler/candidates.js";
import { readState } from "../utils/state.js";
import { safeReadFile, parseFrontmatter } from "../utils/markdown.js";
import { findRelevantChunks, findRelevantPages } from "../utils/embeddings.js";
import { buildContextPack } from "../context/build.js";
import {
  CONCEPTS_DIR,
  INDEX_FILE,
  QUERIES_DIR,
  CHUNK_TOP_K,
} from "../utils/constants.js";
import { ensureProviderAvailable } from "../utils/provider-guard.js";
import { runEval, DEFAULT_SAMPLE_SIZE } from "../eval/index.js";

/** Directories searched (in priority order) when resolving a page slug. */
const PAGE_DIRS = [CONCEPTS_DIR, QUERIES_DIR];

/** Shape returned by search_pages for each matching page. */
interface PageRecord {
  slug: string;
  title: string;
  summary: string;
  body: string;
}

/**
 * Wrap an arbitrary JSON value as the standard MCP CallToolResult.
 * MCP requires content blocks even for structured payloads, so we mirror
 * the JSON in a text block for clients that don't read structuredContent.
 */
function jsonResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: { result: unknown };
} {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: { result: payload },
  };
}

/** Register all 9 wiki tools on the given MCP server instance. */
export function registerWikiTools(server: McpServer, root: string): void {
  registerIngestTool(server, root);
  registerCompileTool(server, root);
  registerQueryTool(server, root);
  registerSearchTool(server, root);
  registerReadTool(server, root);
  registerLintTool(server, root);
  registerStatusTool(server, root);
  registerContextPackTool(server, root);
  registerEvalTool(server, root);
}

function registerIngestTool(server: McpServer, root: string): void {
  server.registerTool(
    "ingest_source",
    {
      title: "Ingest Source",
      description:
        "Fetch a URL or copy a local file into sources/. Returns the saved filename, " +
        "character count, and whether content was truncated to fit the size limit.",
      inputSchema: {
        source: z
          .string()
          .describe("URL (http/https) or absolute path to a .md/.txt file"),
      },
    },
    async ({ source }) => {
      const result = await ingestSource(root, source);
      return jsonResult(result);
    },
  );
}

function registerCompileTool(server: McpServer, root: string): void {
  server.registerTool(
    "compile_wiki",
    {
      title: "Compile Wiki",
      description:
        "Run the incremental compile pipeline: extract concepts from new/changed " +
        "sources, generate wiki pages, resolve interlinks, and rebuild the index. " +
        "Requires an LLM provider with credentials.",
      inputSchema: {},
    },
    async () => {
      ensureProviderAvailable();
      const result = await compileAndReport(root);
      return jsonResult(result);
    },
  );
}

function registerQueryTool(server: McpServer, root: string): void {
  server.registerTool(
    "query_wiki",
    {
      title: "Query Wiki",
      description:
        "Ask a natural-language question. Selects relevant pages with the LLM, " +
        "loads them, and returns a grounded answer with citations. Set save=true " +
        "to persist the answer as a wiki page. Set debug=true to include the " +
        "selected chunks and their scores. Requires an LLM provider.",
      inputSchema: {
        question: z.string().describe("The natural-language question to answer."),
        save: z
          .boolean()
          .optional()
          .describe("Persist the answer as a wiki/queries/ page when true."),
        debug: z
          .boolean()
          .optional()
          .describe("Include retrieval debug info (selected chunks/pages + scores)."),
      },
    },
    async ({ question, save, debug }) => {
      ensureProviderAvailable();
      const result = await generateAnswer(root, question, { save, debug });
      return jsonResult(result);
    },
  );
}

function registerSearchTool(server: McpServer, root: string): void {
  server.registerTool(
    "search_pages",
    {
      title: "Search Pages",
      description:
        "Select pages relevant to a question and return their full content. " +
        "Uses semantic embeddings when available, falling back to LLM-based " +
        "selection over the wiki index. Requires an LLM provider.",
      inputSchema: {
        question: z.string().describe("The query used to rank pages."),
      },
    },
    async ({ question }) => {
      ensureProviderAvailable();
      const slugs = await pickSearchSlugs(root, question);
      const records = await loadPageRecords(root, slugs);
      return jsonResult({ pages: records });
    },
  );
}

/**
 * Resolve search candidates. Tries chunk-level retrieval first (highest
 * precision), then falls back to page-level embeddings, then to LLM-driven
 * selection over the wiki index.
 */
async function pickSearchSlugs(root: string, question: string): Promise<string[]> {
  try {
    const chunks = await findRelevantChunks(root, question, CHUNK_TOP_K);
    if (chunks.length > 0) return dedupePreservingOrder(chunks.map((c) => c.chunk.slug));
  } catch {
    // Chunk store unavailable — fall through to page-level embeddings.
  }

  try {
    const candidates = await findRelevantPages(root, question);
    if (candidates.length > 0) return candidates.map((c) => c.slug);
  } catch {
    // Embeddings unavailable — fall through to index-based selection.
  }

  const indexContent = await safeReadFile(path.join(root, INDEX_FILE));
  const { pages } = await selectPages(question, indexContent);
  return pages;
}

/** Deduplicate slugs while preserving the first-seen ordering. */
function dedupePreservingOrder(slugs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const slug of slugs) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

function registerReadTool(server: McpServer, root: string): void {
  server.registerTool(
    "read_page",
    {
      title: "Read Page",
      description:
        "Read a single wiki page by slug. Searches concepts/ first, then queries/. " +
        "Returns the parsed frontmatter and body. No LLM call required.",
      inputSchema: {
        slug: z.string().describe("Page slug, without .md extension."),
      },
    },
    async ({ slug }) => {
      const page = await readPage(root, slug);
      if (!page) {
        throw new Error(`Page not found: ${slug}`);
      }
      return jsonResult(page);
    },
  );
}

function registerLintTool(server: McpServer, root: string): void {
  server.registerTool(
    "lint_wiki",
    {
      title: "Lint Wiki",
      description:
        "Run rule-based quality checks (broken wikilinks, orphans, duplicates, " +
        "empty pages, broken citations). Returns structured diagnostics. No LLM call.",
      inputSchema: {},
    },
    async () => {
      const summary = await lint(root);
      return jsonResult(summary);
    },
  );
}

function registerStatusTool(server: McpServer, root: string): void {
  server.registerTool(
    "wiki_status",
    {
      title: "Wiki Status",
      description:
        "Summarize the wiki: page count, source count, last compile time, " +
        "orphaned pages, and pending source changes. Read-only — never " +
        "modifies the workspace.",
      inputSchema: {},
    },
    async () => jsonResult(await collectStatus(root)),
  );
}

/**
 * Register the `get_context_pack` tool. Delegates to the same
 * `buildContextPack()` helper as the CLI so the returned JSON matches
 * `llmwiki context --json` byte-for-byte (modulo prompt content).
 *
 * No provider guard runs here: semantic retrieval is opportunistic
 * inside `buildContextPack` and falls back to lexical with a stable
 * warning when credentials are missing. The pack is read-only and
 * never mutates the workspace, so the MCP layer needs no extra checks.
 *
 * The body is split into `contextPackToolConfig` (static metadata) and
 * `buildContextPackFromArgs` (the per-call adapter) so this function
 * stays inside the project's 40-line function ceiling.
 */
function registerContextPackTool(server: McpServer, root: string): void {
  server.registerTool(
    "get_context_pack",
    contextPackToolConfig(),
    async (args) => jsonResult(await buildContextPackFromArgs(root, args)),
  );
}

/** Inline arg shape for {@link buildContextPackFromArgs}; matches `contextPackInputSchema`. */
interface ContextPackToolArgs {
  prompt: string;
  budget?: number;
  depth?: number;
  topPages?: number;
  topChunks?: number;
  omitRoot?: boolean;
  includeSources?: boolean;
}

/** Static `registerTool` metadata for `get_context_pack`. */
function contextPackToolConfig(): {
  title: string;
  description: string;
  inputSchema: ReturnType<typeof contextPackInputSchema>;
} {
  return {
    title: "Get Context Pack",
    description:
      "Build an agent-ready evidence pack for `prompt` over the compiled " +
      "wiki: primary pages, semantic chunks, graph neighbors, citations, " +
      "warnings, and suggested next actions. Returns the same v1 JSON " +
      "envelope as `llmwiki context --json`. Read-only; no provider " +
      "credentials required. Use this to PREPARE evidence; use " +
      "`query_wiki` to GENERATE a grounded natural-language answer.",
    inputSchema: contextPackInputSchema(),
  };
}

/**
 * Zod schema for the `get_context_pack` tool arguments. Extracted so
 * the registration function stays under the project's per-function
 * line ceiling and so the schema can be unit-tested in isolation if
 * we ever need to.
 */
function contextPackInputSchema(): {
  prompt: z.ZodString;
  budget: z.ZodOptional<z.ZodNumber>;
  depth: z.ZodOptional<z.ZodNumber>;
  topPages: z.ZodOptional<z.ZodNumber>;
  topChunks: z.ZodOptional<z.ZodNumber>;
  omitRoot: z.ZodOptional<z.ZodBoolean>;
  includeSources: z.ZodOptional<z.ZodBoolean>;
} {
  return {
    prompt: z.string().describe("Free-text task or topic to assemble context for."),
    budget: z
      .number()
      .optional()
      .describe("Approximate output token budget (default 8000)."),
    depth: z
      .number()
      .optional()
      .describe("Graph neighborhood depth, 0..2 (default 1, 0 disables expansion)."),
    topPages: z.number().optional().describe("Max primary pages (default 5, max 20)."),
    topChunks: z
      .number()
      .optional()
      .describe("Max semantic chunks to surface (default 8, max 50)."),
    omitRoot: z
      .boolean()
      .optional()
      .describe("Emit `project.root` as null instead of the absolute path."),
    includeSources: z
      .boolean()
      .optional()
      .describe(
        "Materialize `primary[].sourceWindows` from claim-level citations " +
          "(reads files under `sources/` only; path-confined).",
      ),
  };
}

/** Per-call adapter that fans the tool args into `buildContextPack`. */
async function buildContextPackFromArgs(
  root: string,
  args: ContextPackToolArgs,
): Promise<Awaited<ReturnType<typeof buildContextPack>>> {
  return buildContextPack({
    root,
    prompt: args.prompt,
    budget: args.budget,
    depth: args.depth,
    topPages: args.topPages,
    topChunks: args.topChunks,
    omitRoot: args.omitRoot,
    includeSources: args.includeSources,
  });
}

function registerEvalTool(server: McpServer, root: string): void {
  server.registerTool(
    "run_eval",
    {
      title: "Run Eval",
      description:
        "Run the wiki quality eval harness. fast suite checks health and citation " +
        "coverage without LLM calls. full suite also LLM-judges a sample of citations " +
        "(requires an LLM provider). " +
        "Set record: true to append results to eval history (default false — read-only).",
      inputSchema: {
        suite: z.enum(["fast", "full"]).optional().default("fast")
          .describe("fast=no LLM calls, full=includes citation support (requires LLM provider)"),
        sampleSize: z.number().int().min(1).max(100).optional()
          .describe(`Citations to sample for citation support (full suite only, default ${DEFAULT_SAMPLE_SIZE})`),
        record: z.boolean().optional().default(false)
          .describe("Append results to eval history (default false; set true to persist a checkpoint)"),
      },
    },
    async ({ suite, sampleSize, record }) => {
      const report = await runEval(root, suite, sampleSize ?? DEFAULT_SAMPLE_SIZE, record ?? false);
      return jsonResult(report);
    },
  );
}


/** Read-only status snapshot used by the wiki_status tool. */
async function collectStatus(root: string): Promise<WikiStatus> {
  const concepts = await collectPageSummaries(path.join(root, CONCEPTS_DIR));
  const queries = await collectPageSummaries(path.join(root, QUERIES_DIR));
  const state = await readState(root);
  const changes = await detectChanges(root, state);
  const orphans = await findOrphanedSlugs(root);
  const pendingCandidates = await countCandidates(root);
  const compileTimes = Object.values(state.sources).map((s) => s.compiledAt);
  const lastCompile = compileTimes.length > 0
    ? compileTimes.sort().slice(-1)[0]
    : null;

  return {
    pages: { concepts: concepts.length, queries: queries.length, total: concepts.length + queries.length },
    sources: Object.keys(state.sources).length,
    lastCompiledAt: lastCompile,
    orphanedPages: orphans,
    pendingCandidates,
    pendingChanges: changes
      .filter((c) => c.status !== "unchanged")
      .map((c) => ({ file: c.file, status: c.status })),
  };
}

interface WikiStatus {
  pages: { concepts: number; queries: number; total: number };
  sources: number;
  lastCompiledAt: string | null;
  orphanedPages: string[];
  /** Number of compile candidates awaiting human review. */
  pendingCandidates: number;
  pendingChanges: Array<{ file: string; status: string }>;
}

/** Find concept slugs whose pages are flagged as orphaned. */
async function findOrphanedSlugs(root: string): Promise<string[]> {
  const scanned = await scanWikiPages(path.join(root, CONCEPTS_DIR));
  return scanned.filter(({ meta }) => meta.orphaned).map(({ slug }) => slug);
}

/** Load full content for a list of slugs, skipping missing/orphaned pages. */
async function loadPageRecords(root: string, slugs: string[]): Promise<PageRecord[]> {
  const records: PageRecord[] = [];
  for (const slug of slugs) {
    const page = await readPage(root, slug);
    if (page) records.push(page);
  }
  return records;
}

/**
 * Locate a page by slug across the priority-ordered page directories,
 * skipping orphaned entries to match the query pipeline's behaviour.
 */
export async function readPage(root: string, slug: string): Promise<PageRecord | null> {
  for (const dir of PAGE_DIRS) {
    const content = await safeReadFile(path.join(root, dir, `${slug}.md`));
    if (!content) continue;

    const { meta, body } = parseFrontmatter(content);
    if (meta.orphaned) continue;

    return {
      slug,
      title: typeof meta.title === "string" ? meta.title : slug,
      summary: typeof meta.summary === "string" ? meta.summary : "",
      body: body.trim(),
    };
  }
  return null;
}

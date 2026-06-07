/**
 * @file src/sdk/types.ts
 * @description Public type surface for the llmwiki in-process SDK.
 *
 * Defines the `Wiki` interface returned by `createWiki`, plus the
 * option shapes that callers pass to each method. All concrete result
 * types are imported directly from their owning modules so consumers
 * who need deeper access can follow the same import path.
 */

import type { CompileResult, IngestResult, QueryResult } from "../utils/types.js";
import type { IngestTextInput } from "../commands/ingest.js";
import type { LintSummary } from "../linter/types.js";
import type { ContextPack } from "../context/types.js";
import type { EvalReport } from "../eval/types.js";
import type { WikiStatus } from "../status/collect.js";
import type { Page, PageRef, ListPagesOptions, ListPagesResult } from "../pages/list.js";
import type { PageRecord } from "../pages/read.js";
import type { JsonExportDocument, BuildJsonExportOptions } from "../export/json-export.js";

/** Options for `createWiki`. */
export interface CreateWikiOptions {
  /** Absolute or relative path to the project root. Normalized once inside `createWiki`. */
  root: string;
}

/** Compile options exposed through the SDK. Mirrors the core CompileOptions shape. */
export interface SdkCompileOptions {
  /** Write generated pages as candidates for review instead of mutating wiki/. */
  review?: boolean;
}

/** Options for `getContextPack`. Maps onto the subset of BuildContextPackOptions needed externally. */
export interface ContextPackOptions {
  /** Free-text prompt the agent supplied. */
  prompt: string;
  /** Token budget (tokens ≈ chars/4). */
  budget?: number;
  /** Graph traversal depth (0–2). */
  depth?: number;
  /** Maximum primary pages to include. */
  topPages?: number;
  /** Maximum semantic chunks to include. */
  topChunks?: number;
}

/**
 * The facade object returned by `createWiki`. Every method runs silently
 * (no console output) and normalizes all paths against the project root
 * supplied at construction time.
 */
export interface Wiki {
  /** Ingest a file path or URL as a new source document. Requires no LLM credentials. */
  ingest(input: { source: string }): Promise<IngestResult>;
  /** Ingest raw text as a new source document. Requires no LLM credentials. */
  ingestText(input: IngestTextInput): Promise<IngestResult>;
  /** Compile all pending sources into wiki pages. Requires LLM credentials. */
  compile(options?: SdkCompileOptions): Promise<CompileResult>;
  /** Pick and hydrate the most relevant pages for a question. Requires LLM credentials. */
  search(question: string): Promise<PageRecord[]>;
  /**
   * Generate a grounded answer from the wiki. Requires LLM credentials.
   *
   * Streaming token delivery (`onToken`) is intentionally NOT exposed by the
   * facade in v1 — only `save` and `debug` are surfaced. Callers needing
   * per-token streaming should use `generateAnswer` directly.
   */
  query(question: string, options?: { save?: boolean; debug?: boolean }): Promise<QueryResult>;
  /** Fetch a single page by directory and slug. No LLM required. */
  getPage(ref: PageRef): Promise<Page | null>;
  /** List wiki pages with optional filters and cursor-based pagination. No LLM required. */
  listPages(options?: ListPagesOptions): Promise<ListPagesResult>;
  /** Collect a read-only status snapshot of the wiki. No LLM required. */
  status(): Promise<WikiStatus>;
  /** Run all lint rules and return a severity-counted summary. No LLM required. */
  lint(): Promise<LintSummary>;
  /**
   * Build a v1 context pack for agent consumption. Lexical retrieval works
   * credential-free; semantic retrieval is opportunistic (skipped when no
   * embeddings are available).
   */
  getContextPack(options: ContextPackOptions): Promise<ContextPack>;
  /** Export the wiki as a structured JSON document. No LLM required. */
  exportJson(options?: BuildJsonExportOptions): Promise<JsonExportDocument>;
  /**
   * Run the eval harness. "fast" mode is credential-free; "full" mode
   * requires LLM credentials for citation-support judging.
   */
  runEval(options: { mode: "fast" | "full"; record?: boolean }): Promise<EvalReport>;
}

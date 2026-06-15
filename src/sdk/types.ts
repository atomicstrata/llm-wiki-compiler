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
import type { SourceRecord, ListSourcesOptions, ListSourcesResult } from "../sources/store.js";
import type { OkfExportReport } from "../export/okf/run.js";
import type { OkfImportReport } from "../import/run.js";

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
  /**
   * Ingest a file path or URL as a new source document. Requires no LLM credentials.
   *
   * **Trust boundary (SSRF + local-file-read primitive):** this method fetches any URL
   * or reads any local file path the caller supplies — server-side — and writes the
   * resulting content into the wiki. Treat `source` as **trusted input only**. Do not
   * pass user-supplied or otherwise untrusted strings here. For untrusted content, use
   * `ingestText` instead (it accepts pre-extracted `{title, text}` with no fetch or
   * file-read step).
   *
   * **Prompt-injection surface:** ingested content is later processed by an LLM during
   * `compile`. Untrusted or adversarially crafted content in sources is therefore a
   * prompt-injection vector into page generation.
   */
  ingest(input: { source: string }): Promise<IngestResult>;
  /**
   * Ingest raw text as a new source document. Requires no LLM credentials.
   *
   * Safe path for untrusted content: no network fetch or local file read is performed.
   * The caller supplies the text directly, so there is no SSRF or path-traversal risk
   * at ingest time (prompt-injection into `compile` still applies if the text itself is
   * adversarial).
   */
  ingestText(input: IngestTextInput): Promise<IngestResult>;
  /**
   * Compile all pending sources into wiki pages. Requires LLM credentials.
   *
   * **Data egress:** source content is sent to the configured LLM provider during
   * compilation. Do not compile wikis that contain confidential data unless the
   * provider's data-handling policies are acceptable for that content.
   *
   * **Silent operation:** progress output is suppressed by the SDK facade. There is no
   * progress callback in v1; structured `onLog` event delivery is planned for v1.x.
   * For long corpora this call may take several minutes with no intermediate feedback.
   */
  compile(options?: SdkCompileOptions): Promise<CompileResult>;
  /**
   * Pick and hydrate the most relevant pages for a question. Requires LLM credentials.
   *
   * **Data egress:** the question (and embedding request) is sent to the configured LLM
   * provider. Wiki page content may also be sent during retrieval scoring.
   */
  search(question: string): Promise<PageRecord[]>;
  /**
   * Generate a grounded answer from the wiki. Requires LLM credentials.
   *
   * **Data egress:** the question and relevant wiki page content are sent to the
   * configured LLM provider to produce the answer.
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
  /** List source files under `sources/` with optional cursor pagination. Bodies are opt-in via `includeBody`. No LLM required. */
  listSources(options?: ListSourcesOptions): Promise<ListSourcesResult>;
  /** Fetch a single source record by its basename id (e.g. "note.md"); returns null if absent. Always includes body. No LLM required. */
  getSource(id: string): Promise<SourceRecord | null>;
  /** Delete the source file for the given id (the id is the `IngestResult.filename`, e.g. "note.md").
   *  Returns true if deleted, false if not found. The compiled page in `wiki/` is NOT removed
   *  immediately — reconciliation happens on the next `compile()`. No LLM required. */
  deleteSource(id: string): Promise<boolean>;
  /**
   * Collect a read-only status snapshot of the wiki. No LLM required.
   *
   * **Per-call cost:** each call hashes and reads the full source corpus —
   * O(total source bytes) — with no cross-call caching. Avoid calling this in a
   * hot loop; an mtime-keyed cache is planned for v1.x.
   */
  status(): Promise<WikiStatus>;
  /**
   * Run all lint rules and return a severity-counted summary. No LLM required.
   *
   * **Per-call cost:** each call hashes and reads the full source corpus —
   * O(total source bytes) — with no cross-call caching. Avoid calling this in a
   * hot loop; an mtime-keyed cache is planned for v1.x.
   */
  lint(): Promise<LintSummary>;
  /**
   * Build a v1 context pack for agent consumption. Lexical retrieval works
   * credential-free; semantic retrieval is opportunistic (skipped when no
   * embeddings are available).
   */
  getContextPack(options: ContextPackOptions): Promise<ContextPack>;
  /**
   * Export the wiki as a structured JSON document. No LLM required.
   *
   * **Per-call cost:** each call hashes and reads the full source corpus —
   * O(total source bytes) — with no cross-call caching. Avoid calling this in a
   * hot loop; an mtime-keyed cache is planned for v1.x.
   */
  exportJson(options?: BuildJsonExportOptions): Promise<JsonExportDocument>;
  /**
   * Run the eval harness. "fast" mode is credential-free; "full" mode
   * requires LLM credentials for citation-support judging.
   *
   * **Silent operation:** the SDK suppresses all progress output. There is no
   * progress callback in v1; structured `onLog` event delivery is planned for v1.x.
   */
  runEval(options: { mode: "fast" | "full"; record?: boolean }): Promise<EvalReport>;
  /** Export the wiki as an OKF v0.1 bundle (default dist/exports/okf). */
  exportOkf(opts?: { out?: string }): Promise<OkfExportReport>;
  /**
   * Import an OKF bundle. Default stages review candidates; `trusted:true` writes live
   * (and runs the full refresh — links/index/MOC/EMBEDDINGS, which may incur provider
   * latency/cost); `dryRun:true` writes nothing.
   */
  importOkf(dir: string, opts?: { trusted?: boolean; dryRun?: boolean }): Promise<OkfImportReport>;
}

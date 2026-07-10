/**
 * Commander action for `llmwiki query <question>`.
 * Two-step LLM-powered wiki query that first selects relevant pages from the
 * wiki index, then streams an answer grounded in those pages. Optionally saves
 * the response as a new page in wiki/queries/.
 *
 * Step 1 - Page Selection: ranks pages via the v3 embedding pipeline, falling
 * back (when embeddings are absent/outdated) to an LLM pick over LIVE,
 * surface-eligible, pageId-keyed candidates — never the rendered wiki/index.md.
 *
 * Step 2 - Answer Generation: Loads the selected pages in full and streams
 * a cited answer to the terminal.
 */

import { existsSync } from "fs";
import path from "path";
import { callClaude } from "../utils/llm.js";
import { safeReadFile, parseFrontmatter } from "../utils/markdown.js";
import { languageDirective } from "../utils/output-language.js";
import * as output from "../utils/output.js";
import { verbose } from "../utils/output.js";
import {
  QUERY_PAGE_LIMIT,
  INDEX_FILE,
  CONCEPTS_DIR,
  QUERIES_DIR,
  CHUNK_TOP_K,
  CHUNK_RERANK_KEEP,
  EMBEDDING_TOP_K,
} from "../utils/constants.js";
import type { ChunkEmbeddingEntry } from "../utils/embeddings.js";
import {
  loadEmbeddingsForSearch,
  findRelevantChunksV3,
  findRelevantPagesV3,
} from "../utils/embeddings-load.js";
import { loadProfile } from "../profile/load.js";
import { rerankWithBm25 } from "../utils/retrieval.js";
import { journalHealthWarning } from "../trust/journal-health-warning.js";
import {
  loadSelectedRefRecords,
  selectFallbackRefs,
  withStaleWarning,
  type SelectedPageRef,
  type SearchWarning,
} from "../search/retrieval.js";
import { slugFromPageId, type PageId } from "../utils/page-id.js";
import type { PageRecordWithId } from "../utils/page-registry.js";
import { selectPages } from "./page-selection.js";
import { maybeSaveQueryPage } from "./query-save.js";
// Re-exported so existing consumers/tests keep importing these from `query.js`
// after the save path moved to `query-save.ts`.
export { summarizeAnswer, maybeSaveQueryPage } from "./query-save.js";
import { appendLog, formatWikilinkList } from "../utils/activity-log.js";
import type { ChunkCitation, QueryResult, RetrievalDebug } from "../utils/types.js";

/** Directories to search when loading selected pages, in priority order. */
const PAGE_DIRS = [CONCEPTS_DIR, QUERIES_DIR];

/**
 * Render candidate pages in the bullet format selectPages() consumes, keyed by
 * each candidate's QUALIFIED `pageId` (NOT bare slug) so same-slug pages
 * (`concepts/foo` vs `papers/foo`) stay distinct keys and the LLM returns the
 * `namespace/slug` token verbatim — mirrors `selectFallbackRefs`'s renderer.
 */
function buildFilteredIndex(
  candidates: Array<{ pageId: PageId; title: string; summary: string }>,
): string {
  return candidates
    .map((entry) => `- **${entry.pageId}**: ${entry.title} — ${entry.summary}`)
    .join("\n");
}

interface SelectedPages {
  /** Canonical qualified refs the answer grounds on (pageId-keyed). */
  refs: SelectedPageRef[];
  reasoning: string;
  /** Chunk citations driving the selection — empty when chunk store is absent. */
  chunks: ChunkCitation[];
  /** Debug snapshot of the retrieval pipeline (only populated in debug mode). */
  debug?: RetrievalDebug;
  /** Embedding-load degrade + journal-health warnings (S6); surfaced in the QueryResult. */
  warnings: SearchWarning[];
}

/**
 * Pick relevant pages through the v3 read pipeline: chunk-aware pre-filter when
 * available, then page-level embeddings, then an LLM fallback over LIVE,
 * surface-eligible, pageId-keyed candidates (opted-out typed pages never reach
 * the selector). A degraded (non-v3 / unavailable) store carries its warning
 * through to the result (S6).
 */
async function selectRelevantPages(
  root: string,
  question: string,
  debug: boolean,
): Promise<SelectedPages> {
  const profile = await loadProfile(root);
  const outcome = await loadEmbeddingsForSearch(root);
  // A pending/unavailable compile journal applies to the whole answer regardless
  // of which retrieval branch wins, so fold it into the base warnings ONCE. An
  // ok journal contributes nothing, so a healthy query's warnings are unchanged.
  const journalWarning = await journalHealthWarning(root);
  const base: SearchWarning[] = journalWarning ? [journalWarning, ...outcome.warnings] : outcome.warnings;
  // Stale entries dropped by EITHER read path are accumulated here and folded
  // into the final warnings, so the all-stale/zero-hits fallback still surfaces
  // `embedding-entry-stale` (a read-path signal regardless of hit count).
  const stalePageIds: PageId[] = [];
  const enrich = (sel: SelectedPages): SelectedPages => ({
    ...sel,
    warnings: withStaleWarning(base, stalePageIds),
  });

  if (outcome.store) {
    const chunkSelection = await trySelectViaChunks(root, outcome.store, question, debug, profile, stalePageIds);
    if (chunkSelection) return enrich(chunkSelection);
    const candidates = await findRelevantPagesV3(root, outcome.store, "search", question, EMBEDDING_TOP_K, profile);
    stalePageIds.push(...candidates.stalePageIds);
    if (candidates.hits.length > 0) return enrich(await selectFromCandidates(question, candidates.hits));
  }

  const { refs, reasoning } = await selectFallbackRefs(root, question, "search", profile);
  return enrich({ refs, reasoning, chunks: [], warnings: [] });
}

/**
 * Run LLM selection over a filtered candidate index built from page-level hits.
 * Candidates are rendered AND resolved by their qualified `pageId`, so a typed
 * page keeps its namespace and same-slug pages never collapse. A returned token
 * that is not a KNOWN candidate pageId is DROPPED — never fabricated into
 * `concepts/<token>` — mirroring `selectFallbackRefs`.
 */
async function selectFromCandidates(
  question: string,
  hits: Array<{ pageId: PageId; slug: string; title: string; summary: string }>,
): Promise<SelectedPages> {
  const filteredIndex = buildFilteredIndex(hits);
  const { pages: rawTokens, reasoning } = await selectPages(question, filteredIndex);
  const byPageId = new Map(hits.map((h) => [h.pageId, h]));
  const refs = rawTokens
    .map((token) => byPageId.get(token as PageId))
    .filter((hit): hit is (typeof hits)[number] => hit !== undefined)
    .map((hit) => ({ pageId: hit.pageId, slug: hit.slug, title: hit.title, kind: "page" as const }));
  return { refs, reasoning, chunks: [], warnings: [] };
}

/**
 * Attempt chunk-level retrieval + reranking against the loaded v3 store. Returns
 * null when no chunk hits exist (caller falls back to page-level retrieval). Any
 * stale entries the chunk read dropped are pushed onto `stalePageIds` (even when
 * this returns null) so the caller can surface `embedding-entry-stale`.
 */
async function trySelectViaChunks(
  root: string,
  store: NonNullable<Awaited<ReturnType<typeof loadEmbeddingsForSearch>>["store"]>,
  question: string,
  debug: boolean,
  profile: Awaited<ReturnType<typeof loadProfile>>,
  stalePageIds: PageId[],
): Promise<SelectedPages | null> {
  const ranked = await tryFindRelevantChunks(root, store, question, profile);
  stalePageIds.push(...ranked.stalePageIds);
  if (ranked.chunks.length === 0) return null;

  const reranked = rerankWithBm25(
    question,
    ranked.chunks.map(({ chunk, pageId, score }) => ({ text: chunk.text, baseScore: score, chunk, pageId })),
  );
  const kept = reranked.slice(0, CHUNK_RERANK_KEEP);
  const reorderingHappened = wasReordered(ranked.chunks, kept.map((k) => k.candidate.chunk));
  const chunkCitations = toChunkCitations(kept);
  const refs = collapseToRefs(kept, QUERY_PAGE_LIMIT);
  const reasoning = buildChunkReasoning(chunkCitations, refs);

  return {
    refs,
    reasoning,
    chunks: chunkCitations,
    warnings: [],
    debug: debug ? buildDebug(chunkCitations, refs, reorderingHappened) : undefined,
  };
}

/** Detect whether reranking actually changed the chunk order. */
function wasReordered(
  before: Array<{ chunk: ChunkEmbeddingEntry }>,
  after: ChunkEmbeddingEntry[],
): boolean {
  const limit = Math.min(before.length, after.length);
  for (let i = 0; i < limit; i++) {
    if (before[i].chunk !== after[i]) return true;
  }
  return false;
}

/** A reranked chunk candidate, carrying its parent page's qualified id. */
interface RankedChunk {
  candidate: { chunk: ChunkEmbeddingEntry; pageId: PageId };
  score: number;
}

/** Convert reranked candidates into citation records consumed downstream. */
function toChunkCitations(ranked: RankedChunk[]): ChunkCitation[] {
  return ranked.map(({ candidate, score }) => ({
    pageId: candidate.pageId,
    slug: candidate.chunk.slug,
    title: candidate.chunk.title,
    chunkIndex: candidate.chunk.chunkIndex,
    score,
    text: candidate.chunk.text,
  }));
}

/**
 * Collapse reranked chunks down to a deduplicated list of parent page REFS,
 * keyed by qualified `pageId` (NOT bare slug) so a typed `papers/foo` chunk and
 * a concept `foo` chunk stay distinct. First-seen order is preserved.
 */
function collapseToRefs(ranked: RankedChunk[], limit: number): SelectedPageRef[] {
  const refs: SelectedPageRef[] = [];
  const seen = new Set<PageId>();
  for (const { candidate } of ranked) {
    if (seen.has(candidate.pageId)) continue;
    seen.add(candidate.pageId);
    refs.push({ pageId: candidate.pageId, slug: candidate.chunk.slug, title: candidate.chunk.title, kind: "chunk" });
    if (refs.length >= limit) break;
  }
  return refs;
}

/** Human-readable reasoning trail for the chunk-driven selection. */
function buildChunkReasoning(chunks: ChunkCitation[], refs: SelectedPageRef[]): string {
  const top = chunks.slice(0, refs.length);
  const summary = top.map((c) => `${c.pageId}#${c.chunkIndex} (${c.score.toFixed(3)})`).join(", ");
  return `Selected ${refs.length} page(s) from ${chunks.length} reranked chunks: ${summary}`;
}

/** Snapshot used by debug mode — pure data, no side-effects. */
function buildDebug(
  chunks: ChunkCitation[],
  refs: SelectedPageRef[],
  reranked: boolean,
): RetrievalDebug {
  const bestPerPage = new Map<PageId, number>();
  for (const c of chunks) {
    const prev = bestPerPage.get(c.pageId);
    if (prev === undefined || c.score > prev) bestPerPage.set(c.pageId, c.score);
  }
  return {
    pages: refs.map((ref) => ({ pageId: ref.pageId, score: bestPerPage.get(ref.pageId) ?? 0 })),
    chunks,
    usedChunks: true,
    reranked,
  };
}

/** Reranker-ready chunk candidates plus the ids the chunk read dropped as stale. */
interface ChunkLookup {
  chunks: Array<{ chunk: ChunkEmbeddingEntry; pageId: PageId; score: number }>;
  stalePageIds: PageId[];
}

/**
 * Chunk-level candidate lookup over the v3 store that never throws. Adapts each
 * live-rehydrated {@link findRelevantChunksV3} hit to the chunk-entry shape the
 * BM25 reranker consumes (its `title` is the slug — query provenance shows the
 * slug, not the title) and forwards the read's `stalePageIds` so the caller can
 * surface `embedding-entry-stale`. Provider failures degrade to an empty list.
 */
async function tryFindRelevantChunks(
  root: string,
  store: NonNullable<Awaited<ReturnType<typeof loadEmbeddingsForSearch>>["store"]>,
  question: string,
  profile: Awaited<ReturnType<typeof loadProfile>>,
): Promise<ChunkLookup> {
  try {
    const { hits, stalePageIds } = await findRelevantChunksV3(root, store, "search", question, CHUNK_TOP_K, profile);
    return { chunks: hits.map((hit) => ({ chunk: toChunkEntry(hit), pageId: hit.pageId, score: hit.score })), stalePageIds };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.status("!", output.dim(`Chunk pre-filter unavailable (${message}); falling back.`));
    return { chunks: [], stalePageIds: [] };
  }
}

/** Project a v3 chunk hit onto the chunk-entry shape the reranker/citations use. */
function toChunkEntry(hit: { slug: string; chunkIndex: number; text: string; contentHash: string }): ChunkEmbeddingEntry {
  return {
    slug: hit.slug,
    title: hit.slug,
    chunkIndex: hit.chunkIndex,
    contentHash: hit.contentHash,
    text: hit.text,
    vector: [],
    updatedAt: "",
  };
}

/**
 * Load the full content of each selected wiki page.
 * Skips pages that don't exist and warns the user.
 * @param root - Absolute path to the project root directory.
 * @param slugs - Array of page slugs to load from wiki/concepts/.
 * @returns Combined page contents with slug headers for context.
 */
export async function loadSelectedPages(root: string, slugs: string[]): Promise<string> {
  const sections: string[] = [];

  for (const slug of slugs) {
    let content = "";
    for (const dir of PAGE_DIRS) {
      const candidate = await safeReadFile(path.join(root, dir, `${slug}.md`));
      if (!candidate) continue;
      const { meta } = parseFrontmatter(candidate);
      if (meta.orphaned) continue;
      content = candidate;
      break;
    }

    if (!content) {
      output.status("?", output.warn(`Page not found: ${slug}.md — skipping`));
      continue;
    }

    sections.push(`--- Page: ${slug} ---\n${content}`);
  }

  return sections.join("\n\n");
}

/** Base system prompt body. The output-language directive is appended at call time. */
const ANSWER_SYSTEM_PROMPT_BASE =
  "You are a knowledge assistant. Answer the question using ONLY the wiki content provided. " +
  "Cite specific pages using [[Page Title]] wikilinks. " +
  "If the wiki doesn't contain enough information, say so.";

/**
 * Build the answer-generation system prompt, appending the configured
 * output-language directive when present (issue #37).
 */
function buildAnswerSystemPrompt(): string {
  const lang = languageDirective();
  return lang ? `${ANSWER_SYSTEM_PROMPT_BASE} ${lang}` : ANSWER_SYSTEM_PROMPT_BASE;
}

/**
 * Call the LLM with the loaded wiki pages as grounding context. When chunk
 * citations are available, they are attached as a "Most relevant excerpts"
 * section so the model can prioritise the precise paragraphs that drove
 * page selection.
 */
async function callAnswerLLM(
  question: string,
  pagesContent: string,
  chunks: ChunkCitation[],
  onToken?: (text: string) => void,
): Promise<string> {
  const provenance = chunks.length > 0 ? buildChunkProvenance(chunks) : "";
  const userMessage =
    `Question: ${question}\n\nRelevant wiki pages:\n${pagesContent}${provenance}`;
  return callClaude({
    system: buildAnswerSystemPrompt(),
    messages: [{ role: "user", content: userMessage }],
    stream: Boolean(onToken),
    onToken,
  });
}

/** Render the top chunk excerpts as a labelled section appended to the prompt. */
function buildChunkProvenance(chunks: ChunkCitation[]): string {
  const sections = chunks.map(
    (chunk) => `--- ${chunk.pageId} (chunk ${chunk.chunkIndex}) ---\n${chunk.text}`,
  );
  return `\n\nMost relevant excerpts (from chunk-level retrieval):\n${sections.join("\n\n")}`;
}

/** Options for generateAnswer — programmatic-friendly. */
interface GenerateAnswerOptions {
  /** Persist the answer as a wiki query page when set. */
  save?: boolean;
  /** Per-token callback for streaming. Omit for non-streaming usage. */
  onToken?: (text: string) => void;
  /** Callback fired once page selection completes — lets CLIs print reasoning before streaming. */
  onPageSelection?: (pages: string[], reasoning: string) => void;
  /** Capture chunk-level provenance + scoring detail in the result. */
  debug?: boolean;
}

/**
 * Run the two-step page-selection + answer-generation pipeline and return
 * a structured QueryResult. This is the programmatic entry point used by
 * the MCP server and any non-CLI consumer.
 *
 * @param root - Absolute path to the project root directory.
 * @param question - The natural language question to answer.
 * @param options - Streaming + save behaviour controls.
 * @returns Answer text, selected slugs, reasoning, and saved slug if applicable.
 */
export async function generateAnswer(
  root: string,
  question: string,
  options: GenerateAnswerOptions = {},
): Promise<QueryResult> {
  if (!existsSync(path.join(root, INDEX_FILE))) {
    throw new Error("Wiki index not found. Run `llmwiki compile` first.");
  }

  const selection = await selectRelevantPages(root, question, Boolean(options.debug));
  // Human/log surfaces use the QUALIFIED pageId so same-slug pages
  // (`concepts/foo` vs `papers/foo`) are distinguishable; the structured
  // `selectedPages` API field stays bare slugs for back-compat (buildResultFields).
  const pages = selection.refs.map((ref) => ref.pageId);
  verbose(`retrieval: ${selection.refs.length} page(s) selected, ${selection.chunks.length} chunk(s) used`);
  options.onPageSelection?.(pages, selection.reasoning);

  // Hydrate via the qualified-id loader (confined, namespace-correct per pageId):
  // a `papers/foo` ref loads wiki/<papers-dir>/foo.md, never wiki/concepts/foo.md.
  const pagesContent = renderRefRecords(await loadSelectedRefRecords(root, selection.refs));
  verbose(`context pack: ${pagesContent.length} chars`);

  if (!pagesContent) {
    return buildEmptyResult(selection);
  }

  const answer = await callAnswerLLM(question, pagesContent, selection.chunks, options.onToken);
  const saved = await maybeSaveQueryPage(root, question, answer, Boolean(options.save));

  // Journal the query only after the answer is produced — matching compile,
  // which logs after finalization — so a mid-flight LLM failure records nothing.
  // Logged here (not in the CLI command) so MCP queries are captured too.
  await appendLog(root, "query", question, {
    details: pages.length > 0 ? [`Pages: ${formatWikilinkList(pages)}`] : [],
  });

  return { answer, saved, ...buildResultFields(selection) };
}

/**
 * Render hydrated ref records into the answer-LLM grounding sections, headed by
 * each page's QUALIFIED `pageId` (so same-slug `concepts/foo` vs `papers/foo`
 * stay distinguishable) and carrying the page title + summary above the body —
 * reconstructed from the parsed record, NOT raw frontmatter (which would leak
 * arbitrary keys). Empty title/summary lines are omitted.
 */
function renderRefRecords(pairs: PageRecordWithId[]): string {
  return pairs.map(renderRefRecord).join("\n\n");
}

/** Render one `{pageId, record}` pair as a qualified-id section with metadata. */
function renderRefRecord({ pageId, record }: PageRecordWithId): string {
  const lines = [`--- Page: ${pageId} ---`];
  if (record.title) lines.push(`# ${record.title}`);
  if (record.summary) lines.push(`> ${record.summary}`);
  lines.push(record.body);
  return lines.join("\n");
}

/** Build the empty-pages result while preserving any debug/chunk context. */
function buildEmptyResult(selection: SelectedPages): QueryResult {
  return { answer: "", ...buildResultFields(selection) };
}

/**
 * The shared identity/diagnostic fields of a {@link QueryResult}: the canonical
 * qualified ids/refs plus the DERIVED legacy display slugs (back-compat).
 */
function buildResultFields(selection: SelectedPages): Omit<QueryResult, "answer" | "saved"> {
  return {
    selectedPages: selection.refs.map((ref) => slugFromPageId(ref.pageId)),
    pageIds: selection.refs.map((ref) => ref.pageId),
    refs: selection.refs,
    reasoning: selection.reasoning,
    debug: selection.debug,
    ...warningsField(selection),
  };
}

/** Surface embedding-load warnings on the result, OMITTING the key when empty (S6). */
function warningsField(selection: SelectedPages): { warnings?: QueryResult["warnings"] } {
  if (selection.warnings.length === 0) return {};
  return { warnings: selection.warnings.map((w) => ({ code: w.code, message: w.message })) };
}

/**
 * Run a two-step LLM-powered query against the knowledge wiki.
 * @param root - Absolute path to the project root directory.
 * @param question - The natural language question to answer.
 * @param options - Command options (e.g. --save to persist the answer).
 */
export default async function queryCommand(
  root: string,
  question: string,
  options: { save?: boolean; debug?: boolean },
): Promise<void> {
  if (!existsSync(path.join(root, INDEX_FILE))) {
    output.status("!", output.error("Wiki index not found. Run `llmwiki compile` first."));
    return;
  }

  output.header("Selecting relevant pages");

  const result = await generateAnswer(root, question, {
    save: options.save,
    debug: options.debug,
    onToken: (text) => process.stdout.write(text),
    onPageSelection: (pages, reasoning) => {
      output.status("i", output.dim(`Reasoning: ${reasoning}`));
      output.status("*", output.info(`Selected ${pages.length} page(s): ${pages.join(", ")}`));
      output.header("Generating answer");
    },
  });

  // Newline after streamed answer so subsequent terminal output formats cleanly.
  process.stdout.write("\n");

  if (result.debug) printDebugSnapshot(result.debug);

  if (!result.answer) {
    output.status("!", output.error("No matching pages found. Try refining your question."));
    return;
  }

  if (result.saved) {
    output.status("→", output.dim("Saved. Future queries will use this answer as context."));
  } else {
    output.status("→", output.dim("Tip: use --save to add this answer to your wiki"));
  }
}

/** Render the retrieval debug snapshot to the terminal for human inspection. */
function printDebugSnapshot(debug: RetrievalDebug): void {
  output.header("Retrieval debug");
  output.status(
    "i",
    output.dim(
      `Source: ${debug.usedChunks ? "chunk-level" : "page-level"}; ` +
      `reranked: ${debug.reranked ? "yes" : "no"}`,
    ),
  );
  for (const page of debug.pages) {
    output.status("•", `${page.pageId} (best chunk score ${page.score.toFixed(3)})`);
  }
  for (const chunk of debug.chunks) {
    const preview = chunk.text.slice(0, DEBUG_CHUNK_PREVIEW_CHARS).replace(/\s+/g, " ").trim();
    output.status(
      "·",
      output.dim(`${chunk.pageId}#${chunk.chunkIndex} score=${chunk.score.toFixed(3)} :: ${preview}…`),
    );
  }
}

/** Maximum chunk preview length printed in --debug output. */
const DEBUG_CHUNK_PREVIEW_CHARS = 120;

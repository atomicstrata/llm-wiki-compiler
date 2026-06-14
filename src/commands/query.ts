/**
 * Commander action for `llmwiki query <question>`.
 * Two-step LLM-powered wiki query that first selects relevant pages from the
 * wiki index, then streams an answer grounded in those pages. Optionally saves
 * the response as a new page in wiki/queries/.
 *
 * Step 1 - Page Selection: Reads wiki/index.md and asks Claude (via tool_use)
 * to pick the most relevant concept pages for the question.
 *
 * Step 2 - Answer Generation: Loads the selected pages in full and streams
 * a cited answer to the terminal.
 */

import { existsSync } from "fs";
import path from "path";
import { callClaude } from "../utils/llm.js";
import type { LLMTool } from "../utils/provider.js";
import { atomicWrite, safeReadFile, slugify, buildFrontmatter, parseFrontmatter } from "../utils/markdown.js";
import { languageDirective } from "../utils/output-language.js";
import { generateIndex } from "../compiler/indexgen.js";
import * as output from "../utils/output.js";
import {
  QUERY_PAGE_LIMIT,
  INDEX_FILE,
  CONCEPTS_DIR,
  QUERIES_DIR,
  CHUNK_TOP_K,
  CHUNK_RERANK_KEEP,
} from "../utils/constants.js";
import {
  findRelevantPages,
  findRelevantChunks,
  type ChunkEmbeddingEntry,
} from "../utils/embeddings.js";
import { updateEmbeddingsDispatched as updateEmbeddings } from "../utils/embeddings-dispatch.js";
import { rerankWithBm25 } from "../utils/retrieval.js";
import { appendLog, formatWikilinkList } from "../utils/activity-log.js";
import type { ChunkCitation, QueryResult, RetrievalDebug } from "../utils/types.js";

/** Directories to search when loading selected pages, in priority order. */
const PAGE_DIRS = [CONCEPTS_DIR, QUERIES_DIR];

/** Tool schema for page selection (provider-agnostic). */
const PAGE_SELECTION_TOOL: LLMTool = {
  name: "select_pages",
  description: "Select the most relevant wiki pages to answer a question",
  input_schema: {
    type: "object" as const,
    properties: {
      pages: {
        type: "array",
        items: {
          type: "string",
          description: "Slug of a relevant wiki page (e.g. 'llm-knowledge-bases')",
        },
        maxItems: QUERY_PAGE_LIMIT,
      },
      reasoning: {
        type: "string",
        description: "Brief explanation of why these pages were selected",
      },
    },
    required: ["pages", "reasoning"],
  },
};

interface PageSelectionResult {
  pages: string[];
  reasoning: string;
}

/**
 * Select the most relevant wiki pages for a question using Claude tool_use.
 * @param question - The user's natural language question.
 * @param indexContent - The full text of wiki/index.md.
 * @returns Parsed page slugs and reasoning from Claude.
 */
export async function selectPages(
  question: string,
  indexContent: string,
): Promise<PageSelectionResult> {
  const systemPrompt =
    "You are a knowledge base assistant. Given a question and a wiki index, select the most relevant pages.";

  const userMessage = `Question: ${question}\n\nWiki Index:\n${indexContent}`;

  const rawResult = await callClaude({
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    tools: [PAGE_SELECTION_TOOL],
  });

  try {
    const parsed = JSON.parse(rawResult);
    return {
      pages: Array.isArray(parsed.pages) ? parsed.pages.filter((p: unknown) => typeof p === "string") : [],
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "No reasoning provided",
    };
  } catch {
    return { pages: [], reasoning: "Failed to parse page selection response" };
  }
}

/** Render a list of candidate pages in the same bullet format selectPages() consumes. */
function buildFilteredIndex(
  candidates: Array<{ slug: string; title: string; summary: string }>,
): string {
  return candidates
    .map((entry) => `- **${entry.slug}**: ${entry.title} — ${entry.summary}`)
    .join("\n");
}

interface SelectedPages {
  pages: string[];
  rawPages: string[];
  reasoning: string;
  /** Chunk citations driving the selection — empty when chunk store is absent. */
  chunks: ChunkCitation[];
  /** Debug snapshot of the retrieval pipeline (only populated in debug mode). */
  debug?: RetrievalDebug;
}

/**
 * Pick relevant pages using a chunk-aware embedding pre-filter when available,
 * falling back to page-level embeddings, then to sending the full wiki index.
 */
async function selectRelevantPages(
  root: string,
  question: string,
  debug: boolean,
): Promise<SelectedPages> {
  const chunkSelection = await trySelectViaChunks(root, question, debug);
  if (chunkSelection) return chunkSelection;

  const candidates = await tryFindRelevantPages(root, question);

  if (candidates.length > 0) {
    const filteredIndex = buildFilteredIndex(candidates);
    const { pages: rawPages, reasoning } = await selectPages(question, filteredIndex);
    // Tool output holds slugs directly in the semantic path — no slugify needed.
    return { pages: rawPages, rawPages, reasoning, chunks: [] };
  }

  const indexContent = await safeReadFile(path.join(root, INDEX_FILE));
  const { pages: rawPages, reasoning } = await selectPages(question, indexContent);
  return { pages: rawPages.map((p) => slugify(p)), rawPages, reasoning, chunks: [] };
}

/**
 * Attempt chunk-level retrieval + reranking. Returns null when no chunk store
 * is available (caller falls back to page-level retrieval transparently).
 */
async function trySelectViaChunks(
  root: string,
  question: string,
  debug: boolean,
): Promise<SelectedPages | null> {
  const ranked = await tryFindRelevantChunks(root, question);
  if (ranked.length === 0) return null;

  const reranked = rerankWithBm25(
    question,
    ranked.map(({ chunk, score }) => ({ text: chunk.text, baseScore: score, chunk })),
  );
  const kept = reranked.slice(0, CHUNK_RERANK_KEEP);
  const reorderingHappened = wasReordered(ranked, kept.map((k) => k.candidate.chunk));
  const chunkCitations = toChunkCitations(kept);
  const pageSlugs = collapseToPages(chunkCitations, QUERY_PAGE_LIMIT);
  const reasoning = buildChunkReasoning(chunkCitations, pageSlugs);

  return {
    pages: pageSlugs,
    rawPages: pageSlugs,
    reasoning,
    chunks: chunkCitations,
    debug: debug ? buildDebug(chunkCitations, pageSlugs, reorderingHappened) : undefined,
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

interface RankedChunk {
  candidate: { chunk: ChunkEmbeddingEntry };
  score: number;
}

/** Convert reranked candidates into citation records consumed downstream. */
function toChunkCitations(ranked: RankedChunk[]): ChunkCitation[] {
  return ranked.map(({ candidate, score }) => ({
    slug: candidate.chunk.slug,
    title: candidate.chunk.title,
    chunkIndex: candidate.chunk.chunkIndex,
    score,
    text: candidate.chunk.text,
  }));
}

/** Collapse chunk citations down to a deduplicated list of parent page slugs. */
function collapseToPages(chunks: ChunkCitation[], limit: number): string[] {
  const slugs: string[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    if (seen.has(chunk.slug)) continue;
    seen.add(chunk.slug);
    slugs.push(chunk.slug);
    if (slugs.length >= limit) break;
  }
  return slugs;
}

/** Human-readable reasoning trail for the chunk-driven selection. */
function buildChunkReasoning(chunks: ChunkCitation[], pages: string[]): string {
  const top = chunks.slice(0, pages.length);
  const summary = top.map((c) => `${c.slug}#${c.chunkIndex} (${c.score.toFixed(3)})`).join(", ");
  return `Selected ${pages.length} page(s) from ${chunks.length} reranked chunks: ${summary}`;
}

/** Snapshot used by debug mode — pure data, no side-effects. */
function buildDebug(
  chunks: ChunkCitation[],
  pageSlugs: string[],
  reranked: boolean,
): RetrievalDebug {
  const bestPerPage = new Map<string, number>();
  for (const c of chunks) {
    const prev = bestPerPage.get(c.slug);
    if (prev === undefined || c.score > prev) bestPerPage.set(c.slug, c.score);
  }
  return {
    pages: pageSlugs.map((slug) => ({ slug, score: bestPerPage.get(slug) ?? 0 })),
    chunks,
    usedChunks: true,
    reranked,
  };
}

/** Chunk-level candidate lookup that never throws. */
async function tryFindRelevantChunks(
  root: string,
  question: string,
): Promise<Array<{ chunk: ChunkEmbeddingEntry; score: number }>> {
  try {
    return await findRelevantChunks(root, question, CHUNK_TOP_K);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.status("!", output.dim(`Chunk pre-filter unavailable (${message}); falling back.`));
    return [];
  }
}

/** Embedding-based candidate lookup that never throws. */
async function tryFindRelevantPages(
  root: string,
  question: string,
): Promise<Array<{ slug: string; title: string; summary: string }>> {
  try {
    return await findRelevantPages(root, question);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.status("!", output.dim(`Semantic pre-filter unavailable (${message}); using full index.`));
    return [];
  }
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
    (chunk) => `--- ${chunk.slug} (chunk ${chunk.chunkIndex}) ---\n${chunk.text}`,
  );
  return `\n\nMost relevant excerpts (from chunk-level retrieval):\n${sections.join("\n\n")}`;
}

/**
 * Generate a one-line summary from the answer for use in the wiki index.
 * Takes the first sentence (up to 120 chars) so the page-selection LLM
 * has retrieval signal beyond just the title.
 * @param answer - The full answer text.
 * @returns A short summary string.
 */
export function summarizeAnswer(answer: string): string {
  const firstLine = answer.trim().split(/\n/)[0] ?? "";
  const firstSentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine;
  return firstSentence.slice(0, 120);
}

/**
 * Save a query answer as a wiki page in the queries/ directory,
 * then regenerate the wiki index so the answer is immediately retrievable.
 * @param root - Absolute path to the project root directory.
 * @param question - The original question used as the page title.
 * @param answer - The generated answer body.
 */
async function saveQueryPage(root: string, question: string, answer: string): Promise<string> {
  const slug = slugify(question);
  const filePath = path.join(root, QUERIES_DIR, `${slug}.md`);

  const frontmatter = buildFrontmatter({
    title: question,
    summary: summarizeAnswer(answer),
    type: "query",
    createdAt: new Date().toISOString(),
  });

  const document = `${frontmatter}\n\n${answer}\n`;
  await atomicWrite(filePath, document);

  output.status(
    "+",
    output.success(`Saved query → ${output.source(filePath)}`),
  );

  // Regenerate the index so the saved query is immediately discoverable
  // by the next query's page-selection step.
  await generateIndex(root);

  // Index the new query so semantic search retrieves it on the next question.
  // Non-critical: embedding failures (e.g. missing VOYAGE_API_KEY) don't block save.
  try {
    await updateEmbeddings(root, [slug]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.status("!", output.warn(`Skipped embeddings update: ${message}`));
  }

  return slug;
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
  options.onPageSelection?.(selection.pages, selection.reasoning);

  const pagesContent = await loadSelectedPages(root, selection.pages);

  if (!pagesContent) {
    return buildEmptyResult(selection);
  }

  const answer = await callAnswerLLM(question, pagesContent, selection.chunks, options.onToken);
  const saved = options.save ? await saveQueryPage(root, question, answer) : undefined;

  // Journal the query only after the answer is produced — matching compile,
  // which logs after finalization — so a mid-flight LLM failure records nothing.
  // Logged here (not in the CLI command) so MCP queries are captured too.
  await appendLog(root, "query", question, {
    details: selection.pages.length > 0 ? [`Pages: ${formatWikilinkList(selection.pages)}`] : [],
  });

  return {
    answer,
    selectedPages: selection.pages,
    reasoning: selection.reasoning,
    saved,
    debug: selection.debug,
  };
}

/** Build the empty-pages result while preserving any debug/chunk context. */
function buildEmptyResult(selection: SelectedPages): QueryResult {
  return {
    answer: "",
    selectedPages: selection.pages,
    reasoning: selection.reasoning,
    debug: selection.debug,
  };
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
    output.status("•", `${page.slug} (best chunk score ${page.score.toFixed(3)})`);
  }
  for (const chunk of debug.chunks) {
    const preview = chunk.text.slice(0, DEBUG_CHUNK_PREVIEW_CHARS).replace(/\s+/g, " ").trim();
    output.status(
      "·",
      output.dim(`${chunk.slug}#${chunk.chunkIndex} score=${chunk.score.toFixed(3)} :: ${preview}…`),
    );
  }
}

/** Maximum chunk preview length printed in --debug output. */
const DEBUG_CHUNK_PREVIEW_CHARS = 120;

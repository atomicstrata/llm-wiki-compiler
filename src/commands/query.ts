/**
 * Commander action for `llmwiki query <question>`.
 * Two-step LLM-powered wiki query that first selects relevant pages from the
 * wiki index, then streams an answer grounded in those pages. Optionally saves
 * the response as a new page in wiki/queries/.
 *
 * Step 1 - Page Selection: lives in `query-selection.ts` — ranks pages via the
 * v3 embedding pipeline, falling back (when embeddings are absent/outdated/
 * failing) to an LLM pick over LIVE, surface-eligible, pageId-keyed candidates
 * — never the rendered wiki/index.md.
 *
 * Step 2 - Answer Generation: Loads the selected pages in full and streams
 * a cited answer to the terminal. The result's identity fields (`pageIds`/
 * `refs`/`selectedPages`) are built from the HYDRATED pages — the ones actually
 * rendered into the prompt — so a selected page that failed to hydrate is never
 * reported as grounding; it surfaces as a `page-hydration-dropped` warning.
 */

import { existsSync } from "fs";
import path from "path";
import { callClaude } from "../utils/llm.js";
import { safeReadFile, parseFrontmatter } from "../utils/markdown.js";
import { languageDirective } from "../utils/output-language.js";
import * as output from "../utils/output.js";
import { verbose } from "../utils/output.js";
import { INDEX_FILE, CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import { loadSelectedRefRecords } from "../search/retrieval.js";
import { slugFromPageId, type PageId } from "../utils/page-id.js";
import type { PageRecordWithId } from "../utils/page-registry.js";
import { selectRelevantPages, type SelectedPages } from "./query-selection.js";
import { maybeSaveQueryPage, assertQuerySaveOptions } from "./query-publication.js";
export { assertQuerySaveOptions } from "./query-publication.js";
import { buildQueryDocument } from "./query-document.js";
import { printAnswerCitationReport, reportQueryAnswerCitations } from "./query-citation-report.js";
// Preserve the existing summary helper import for consumers/tests.
export { summarizeAnswer } from "./query-save.js";
import { appendLog, formatWikilinkList } from "../utils/activity-log.js";
import type { ChunkCitation, QueryResult, QueryWarning, RetrievalDebug } from "../utils/types.js";

/** Directories to search when loading selected pages, in priority order. */
const PAGE_DIRS = [CONCEPTS_DIR, QUERIES_DIR];

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
  /** Opt into embedding-error recovery; scoped/review queries default to fallback. */
  embeddingFailure?: "throw" | "fallback";
  /** Report/filter to hydrated grounding. Scoped/review queries always use this mode. */
  grounding?: "hydrated";
  /** Persist the answer as a wiki query page when set. */
  save?: boolean;
  /**
   * With `save`, stage the answer as a validated review candidate instead of
   * writing `wiki/queries/` directly — the operator applies it via `review
   * approve`, which re-validates citations freshly. Requires `save`.
   */
  review?: boolean;
  /** Per-token callback for streaming. Omit for non-streaming usage. */
  onToken?: (text: string) => void;
  /** Callback fired once page selection completes — lets CLIs print reasoning before streaming. */
  onPageSelection?: (pages: string[], reasoning: string) => void;
  /** Capture chunk-level provenance + scoring detail in the result. */
  debug?: boolean;
  /**
   * Qualified page ids retrieval may draw from (D-GROUNDING-SCOPE). Narrows the store and
   * the fallback candidates BEFORE ranking, so the model only ever sees in-scope pages and
   * `pageIds` never names a page outside it. Empty = nothing may ground. Omitted = whole wiki.
   */
  pageScope?: readonly string[];
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
  // `review` without `save` is rejected by the user-facing query surfaces (the
  // CLI action, `queryCommand`, and the SDK facade's `wiki.query`). This lower-
  // level function is also exported for compatibility, and here `review` alone
  // only selects review-mode grounding; nothing is published unless `save` is set.
  if (!existsSync(path.join(root, INDEX_FILE))) {
    throw new Error("Wiki index not found. Run `llmwiki compile` first.");
  }

  const scopedOrReview = options.pageScope !== undefined || options.review === true;
  const hydratedGrounding = scopedOrReview || options.grounding === "hydrated";
  const selection = await selectRelevantPages(root, question, Boolean(options.debug), options.pageScope, {
    embeddingFailure: options.embeddingFailure ?? (scopedOrReview ? "fallback" : "throw"),
  });
  // Human/log surfaces use the QUALIFIED pageId so same-slug pages
  // (`concepts/foo` vs `papers/foo`) are distinguishable; the structured
  // `selectedPages` API field stays bare slugs for back-compat (buildResultFields).
  const pages = selection.refs.map((ref) => ref.pageId);
  verbose(`retrieval: ${selection.refs.length} page(s) selected, ${selection.chunks.length} chunk(s) used`);
  options.onPageSelection?.(pages, selection.reasoning);

  // Hydrate via the qualified-id loader (confined, namespace-correct per pageId):
  // a `papers/foo` ref loads wiki/<papers-dir>/foo.md, never wiki/concepts/foo.md.
  // Scoped/review and explicitly hydrated queries use the live pairs as their
  // grounding identity. Ordinary public queries retain their selected-ref contract.
  const hydratedPairs = await loadSelectedRefRecords(root, selection.refs);
  const pagesContent = renderRefRecords(hydratedPairs);
  verbose(`context pack: ${pagesContent.length} chars`);

  if (!pagesContent) {
    return buildEmptyResult(selection, hydratedGrounding ? hydratedPairs : undefined);
  }

  // Hydrated mode restricts excerpts to the reported live parents; ordinary
  // queries preserve the public prompt, including excerpts beyond the ref cap.
  const hydratedIds = new Set(hydratedPairs.map((pair) => pair.pageId));
  const promptChunks = hydratedGrounding
    ? selection.chunks.filter((chunk) => hydratedIds.has(chunk.pageId)) : selection.chunks;
  const answer = await callAnswerLLM(question, pagesContent, promptChunks, options.onToken);
  // Advisory citation report over the canonical saved body: a snapshot for the
  // caller, never permission to publish. Its failure preserves the answer.
  const { document, body } = buildQueryDocument(question, answer, new Date().toISOString());
  const citationFields = await reportQueryAnswerCitations(root, body);
  const publication = await maybeSaveQueryPage({ root, question, answer, save: Boolean(options.save), review: options.review, document });

  // Preserve the public activity log for ordinary CLI/MCP questions, even when
  // not saved as pages. Explicitly scoped reads and review proposals retain
  // their no-activity-log contract; a saved scoped answer is a write.
  // Log only after generation succeeds, using the selected grounding policy.
  const resultFields = buildResultFields(selection, hydratedGrounding ? hydratedPairs : undefined);
  if (options.review !== true && (options.save === true || options.pageScope === undefined)) {
    await appendLog(root, "query", question, {
      details: resultFields.pageIds.length > 0 ? [`Pages: ${formatWikilinkList(resultFields.pageIds)}`] : [],
    });
  }

  return { answer, ...publication, ...resultFields, ...citationFields };
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
function buildEmptyResult(selection: SelectedPages, hydratedPairs?: PageRecordWithId[]): QueryResult {
  return { answer: "", ...buildResultFields(selection, hydratedPairs), answerCitations: { version: 1, citations: [] } };
}

/**
 * The shared identity/diagnostic fields of a {@link QueryResult}, built from
 * selected refs by default, matching public behavior. With hydrated pairs,
 * drop unreadable refs and report them as `page-hydration-dropped` warnings.
 */
function buildResultFields(
  selection: SelectedPages,
  hydratedPairs?: PageRecordWithId[],
): Omit<QueryResult, "answer" | "saved"> {
  const hydratedIds = hydratedPairs && new Set(hydratedPairs.map((pair) => pair.pageId));
  const refs = hydratedIds ? selection.refs.filter((ref) => hydratedIds.has(ref.pageId)) : selection.refs;
  const droppedIds = selection.refs
    .filter((ref) => hydratedIds && !hydratedIds.has(ref.pageId))
    .map((ref) => ref.pageId);
  return {
    selectedPages: refs.map((ref) => slugFromPageId(ref.pageId)),
    pageIds: refs.map((ref) => ref.pageId),
    refs,
    reasoning: selection.reasoning,
    debug: selection.debug,
    ...warningsField(selection, droppedIds),
  };
}

/**
 * Surface selection warnings plus any hydration drop on the result, OMITTING
 * the key entirely when there is nothing to report (S6).
 */
function warningsField(
  selection: SelectedPages,
  droppedIds: PageId[],
): { warnings?: QueryResult["warnings"] } {
  const warnings: QueryWarning[] = selection.warnings.map((w) => ({ code: w.code, message: w.message }));
  if (droppedIds.length > 0) {
    warnings.push({
      code: "page-hydration-dropped",
      message: `Selected page(s) failed to hydrate and were dropped from grounding: ${droppedIds.join(", ")}.`,
    });
  }
  return warnings.length === 0 ? {} : { warnings };
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
  options: { save?: boolean; debug?: boolean; review?: boolean },
): Promise<void> {
  assertQuerySaveOptions(options);
  if (!existsSync(path.join(root, INDEX_FILE))) {
    output.status("!", output.error("Wiki index not found. Run `llmwiki compile` first."));
    return;
  }

  output.header("Selecting relevant pages");

  const result = await generateAnswer(root, question, {
    save: options.save,
    review: options.review,
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

  if (result.answerCitations) printAnswerCitationReport(result.answerCitations);

  printPublicationOutcome(result, Boolean(options.save));
}

/** Distinguish a published page, staged proposal, and answer-preserving refusal. */
function printPublicationOutcome(result: QueryResult, saveRequested: boolean): void {
  if (result.publicationRefusal) {
    if (result.publicationRefusal.code !== "profile-disabled") {
      output.status("!", output.error(result.publicationRefusal.message));
      process.exitCode = 1;
    }
  } else if (result.candidateId) {
    output.status("→", output.info(`Staged answer for review: ${result.candidateId}`));
    output.status("→", output.dim(`Inspect with: llmwiki review show ${result.candidateId}`));
  } else if (result.saved) {
    output.status("→", output.dim("Saved. Future queries will use this answer as context."));
  } else if (!saveRequested) {
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

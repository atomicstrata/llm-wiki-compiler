/**
 * Concept-extraction phase (Phase 1) for the compilation pipeline.
 *
 * Owns the single responsibility of turning source files into
 * {@link ExtractionResult}s via the LLM: reading each source, sending it (with
 * the confined wiki index as dedup context) to the extraction model, and
 * fanning the batch out under a shared concurrency limit with first-failure
 * short-circuit. Expands the directly-changed batch to any unchanged sources
 * whose concepts overlap newly-extracted slugs. No pages are written here — the
 * results feed the page-generation phase in the orchestration spine.
 */

import { readFile } from "fs/promises";
import path from "path";
import {
  readConfinedWikiFile,
  warnDroppedWikiReadIfPresent,
} from "./confined-wiki-read.js";
import { callClaude } from "../utils/llm.js";
import {
  CONCEPT_EXTRACTION_TOOL,
  buildExtractionPrompt,
  parseConcepts,
} from "./prompts.js";
import {
  findLateAffectedSources,
  type ExtractionResult,
} from "./deps.js";
import * as output from "../utils/output.js";
import { verbose } from "../utils/output.js";
import { INDEX_FILE, SOURCES_DIR } from "../utils/constants.js";
import pLimit from "p-limit";
import type {
  ExtractedConcept,
  SourceChange,
  WikiState,
} from "../utils/types.js";

/**
 * Extract a batch of sources in parallel under a shared concurrency limit.
 *
 * Promise.all preserves input order, so the result matches the old serial
 * order that mergeExtractions relies on when reconciling same-slug concepts.
 * On the first hard failure a shared `aborted` flag short-circuits every
 * not-yet-started source: pLimit keeps draining its queue after Promise.all
 * rejects, and without this guard those queued sources would still issue their
 * (now-pointless) LLM calls — wasted cost/quota exactly when the provider is
 * already failing. In-flight sources still finish; only the queue is skipped.
 */
async function extractSourcesLimited(
  root: string,
  files: string[],
  limit: ReturnType<typeof pLimit>,
): Promise<ExtractionResult[]> {
  let aborted = false;
  return Promise.all(files.map((file) => limit(async () => {
    if (aborted) throw new Error(`extraction skipped for ${file}: a prior source failed`);
    try {
      return await extractForSource(root, file);
    } catch (err) {
      aborted = true;
      throw err;
    }
  })));
}

/**
 * The two views a compile has of its own changes. They answer different
 * questions and are NOT interchangeable, so they travel as one named pair
 * rather than as two same-typed positional arguments that can be swapped.
 */
export interface ChangeSets {
  /** What this run acts on, after any `changeFilter`. */
  scoped: SourceChange[];
  /** Everything found on disk, before any `changeFilter`. */
  detected: SourceChange[];
}

/**
 * Phase 1: extract concepts for the directly-changed batch, then repeatedly
 * expand to unchanged sources whose concepts overlap newly extracted slugs.
 * Every batch shares one `pLimit(concurrency)` cap. Discovery continues to a
 * fixed point because a late owner's extraction can reveal another owner that
 * was absent from its prior state entry.
 */
export async function runExtractionPhases(
  root: string,
  toCompile: SourceChange[],
  state: WikiState,
  changeSets: ChangeSets,
  concurrency: number,
): Promise<ExtractionResult[]> {
  const limit = pLimit(concurrency);
  const extractions = await extractSourcesLimited(root, toCompile.map((c) => c.file), limit);

  while (true) {
    const extracted = new Set(extractions.map((result) => result.sourceFile));
    const lateAffected = findLateAffectedSources(
      extractions, state, changeSets.scoped, extracted, changeSets.detected,
    );
    if (lateAffected.length === 0) break;
    for (const file of lateAffected) {
      output.status("~", output.info(`${file} [shares concept with new source]`));
    }
    const batch = await extractSourcesLimited(root, lateAffected, limit);
    extractions.push(...batch);
  }

  return extractions;
}

/**
 * Phase 1: Extract concepts from a source without generating pages.
 * Returns extraction data for the generation phase.
 */
async function extractForSource(
  root: string,
  sourceFile: string,
): Promise<ExtractionResult> {
  output.status("*", output.info(`Extracting: ${sourceFile}`));

  const sourcePath = path.join(root, SOURCES_DIR, sourceFile);
  const sourceContent = await readFile(sourcePath, "utf-8");
  const lines = sourceContent.split("\n").length;
  const chars = sourceContent.length;
  verbose(`source ${sourceFile}: ${lines} lines, ${chars} chars`);
  const existingIndex = await readConfinedExtractionIndex(root);
  const concepts = await extractConcepts(sourceContent, existingIndex);

  if (concepts.length > 0) {
    const names = concepts.map((c) => c.concept).join(", ");
    output.status("*", output.dim(`  Found ${concepts.length} concepts: ${names}`));
  }
  return { sourceFile, sourcePath, sourceContent, concepts };
}

/**
 * Read `wiki/index.md` through the confined helper for the EXTRACTION prompt.
 * The index bytes are sent to the extraction LLM as dedup context, so a
 * symlinked `wiki/index.md` whose target escapes the project root is dropped
 * (warned, skipped) and extraction proceeds with an EMPTY index — its
 * out-of-tree bytes never reach the provider. An absent index yields an empty
 * string, byte-identical to before.
 *
 * This is the fixed-file (`readConfinedWikiFile`) twin of the per-page
 * `readWikiPageContentOrWarn(..., warnAlways=false)` policy: absence is normal,
 * so the drop warning fires only when the file physically exists.
 */
async function readConfinedExtractionIndex(root: string): Promise<string> {
  const result = await readConfinedWikiFile(root, INDEX_FILE);
  if ("content" in result) return result.content;
  // An absent index shares the escapes-dir reason; warn only when index.md
  // physically exists (an escaping symlink or a fail-closed read).
  await warnDroppedWikiReadIfPresent(path.join(root, INDEX_FILE), INDEX_FILE, result.dropped);
  return "";
}

/**
 * Call Claude to extract concepts from a source document.
 * @param sourceContent - Full source document text.
 * @param existingIndex - Current wiki index for deduplication.
 * @returns Parsed array of extracted concepts.
 */
async function extractConcepts(
  sourceContent: string,
  existingIndex: string,
): Promise<ExtractedConcept[]> {
  const system = buildExtractionPrompt(sourceContent, existingIndex);
  const rawOutput = await callClaude({
    system,
    messages: [{ role: "user", content: "Extract the key concepts from this source." }],
    tools: [CONCEPT_EXTRACTION_TOOL],
  });

  return parseConcepts(rawOutput);
}

/**
 * Concept-extraction phase (Phase 1) for the compilation pipeline.
 *
 * Owns the single responsibility of turning source files into
 * {@link ExtractionResult}s via the LLM: reading each source, sending it (with
 * the confined wiki index as dedup context) to the extraction model, and
 * fanning the batch out under a shared concurrency limit that stops at the
 * first failure and drains what it admitted. Expands the directly-changed batch to any unchanged sources
 * whose concepts overlap newly-extracted slugs. No pages are written here — the
 * results feed the page-generation phase in the orchestration spine.
 */

import path from "path";
import type { CompileAccess } from "./compile-access.js";
import { callClaude } from "../utils/llm.js";
import {
  CONCEPT_EXTRACTION_TOOL,
  buildExtractionPrompt,
  parseConceptExtraction,
  parseConcepts,
} from "./prompts.js";
import { noPagesLimitEnabled } from "./prompt-modifiers.js";
import {
  findLateAffectedSources,
  type ExtractionResult,
} from "./deps.js";
import * as output from "../utils/output.js";
import { verbose } from "../utils/output.js";
import { SOURCES_DIR } from "../utils/constants.js";
import pLimit from "p-limit";
import { reusableExtraction } from "./extraction-snapshot.js";
import { runLimitedUntilFailure } from "./limited-until-failure.js";
import type {
  ExtractedConcept,
  SourceChange,
  WikiState,
} from "../utils/types.js";

/**
 * Extract a batch of sources in parallel under a shared concurrency limit.
 *
 * Results keep input order, so they match the old serial order that
 * mergeExtractions relies on when reconciling same-slug concepts. On the first
 * hard failure no not-yet-started source makes its (now-pointless) LLM call,
 * every source already in flight settles, and then the original error escapes
 * ({@link runLimitedUntilFailure}), so the compile never unwinds past its lock
 * while an extraction call is outstanding. An unusable extraction (`failed`)
 * is a result, not a hard failure, and does not stop the batch.
 */
async function extractSourcesLimited(
  access: CompileAccess,
  files: string[],
  limit: ReturnType<typeof pLimit>,
  reuse: ExtractionReuse,
): Promise<ExtractionResult[]> {
  return runLimitedUntilFailure(limit, files, (file) => extractForSource(access, file, reuse));
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

/** Only unchanged sources not explicitly requested by this run may reuse metadata. */
interface ExtractionReuse {
  state: WikiState;
  eligible: ReadonlySet<string>;
}

/**
 * Phase 1: extract concepts for the directly-changed batch, then repeatedly
 * expand to unchanged sources whose concepts overlap newly extracted slugs.
 * Every batch shares one `pLimit(concurrency)` cap. Discovery continues to a
 * fixed point because a late owner's extraction can reveal another owner that
 * was absent from its prior state entry.
 */
export async function runExtractionPhases(
  access: CompileAccess,
  toCompile: SourceChange[],
  state: WikiState,
  changeSets: ChangeSets,
  concurrency: number,
  reusableSources: ReadonlySet<string> = new Set(),
): Promise<ExtractionResult[]> {
  const limit = pLimit(concurrency);
  const reuse = { state, eligible: reusableSources };
  const extractions = await extractSourcesLimited(access, toCompile.map((c) => c.file), limit, reuse);

  while (true) {
    const extracted = new Set(extractions.map((result) => result.sourceFile));
    const lateAffected = findLateAffectedSources(
      extractions, state, changeSets.scoped, extracted, changeSets.detected,
    );
    if (lateAffected.length === 0) break;
    for (const file of lateAffected) {
      output.status("~", output.info(`${file} [shares concept with new source]`));
    }
    const batch = await extractSourcesLimited(access, lateAffected, limit, reuse);
    extractions.push(...batch);
  }

  return extractions;
}

/**
 * Phase 1: Extract concepts from a source without generating pages.
 * Returns extraction data for the generation phase.
 */
export async function extractForSource(
  access: CompileAccess,
  sourceFile: string,
  reuse: ExtractionReuse,
): Promise<ExtractionResult> {
  // Project-relative: the result names the source, it does not locate it. Every
  // later read of the source goes back through the access seam by file name.
  const sourcePath = path.join(SOURCES_DIR, sourceFile);
  const sourceContent = await access.readSource(sourceFile);
  const cached = reuse.eligible.has(sourceFile)
    ? reusableExtraction(reuse.state.sources[sourceFile], sourceContent) : undefined;
  if (cached) {
    output.status("~", output.dim(`Reusing extraction: ${sourceFile}`));
    return { sourceFile, sourcePath, sourceContent, concepts: cached, reused: true };
  }
  output.status("*", output.info(`Extracting: ${sourceFile}`));
  const lines = sourceContent.split("\n").length;
  const chars = sourceContent.length;
  verbose(`source ${sourceFile}: ${lines} lines, ${chars} chars`);
  const existingIndex = await access.readExtractionIndex();
  const concepts = await extractConcepts(sourceContent, existingIndex);

  if (concepts && concepts.length > 0) {
    const names = concepts.map((c) => c.concept).join(", ");
    output.status("*", output.dim(`  Found ${concepts.length} concepts: ${names}`));
  }
  return { sourceFile, sourcePath, sourceContent, concepts: concepts ?? [],
    ...(concepts === undefined ? { failed: true as const } : {}),
    previousConcepts: reuse.state.sources[sourceFile]?.concepts ?? [] };
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
): Promise<ExtractedConcept[] | undefined> {
  const system = buildExtractionPrompt(sourceContent, existingIndex);
  const rawOutput = await callClaude({
    purpose: "compile.extract-concepts",
    system,
    messages: [{ role: "user", content: "Extract the key concepts from this source." }],
    tools: [CONCEPT_EXTRACTION_TOOL],
  });

  if (noPagesLimitEnabled()) return parseConceptExtraction(rawOutput);
  const concepts = parseConcepts(rawOutput);
  return concepts.length > 0 ? concepts : undefined;
}

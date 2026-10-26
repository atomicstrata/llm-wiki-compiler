/**
 * Commander action for `llmwiki ingest <source>`.
 *
 * Detects the source type (URL, image, PDF, transcript, or generic file),
 * delegates to the appropriate ingestion module, and saves the result as a
 * markdown file with YAML frontmatter in the sources/ directory.
 *
 * Source type is persisted in frontmatter under the `sourceType` key for
 * downstream tooling and human readers.
 *
 * ONE BODY PER ENTRY, TWO PROJECT STEPS. {@link ingestSourceWith} and
 * {@link ingestTextSourceWith} decide over {@link IngestProjectSteps}: the gated
 * save, then the journal entry for a real write only. The operator-named input
 * (a URL or a local path) is HOST input, not project storage, and is fetched in
 * the body as before. The root forms keep their signatures and pass the local
 * steps, built per call, which call the incumbent `saveSourceUnderProjectGate`
 * and journal append when asked, so module spies and mocks still intercept. The
 * registered-project lock stays inside the local save.
 */

import path from "path";
import { readFile } from "fs/promises";
import { createHash } from "node:crypto";
import { buildFrontmatter } from "../utils/markdown.js";
import { saveSourceUnderProjectGate } from "../operation-bundles/registered-project-lock.js";
import { appendLog } from "../utils/activity-log.js";
import { MAX_SOURCE_CHARS, MIN_SOURCE_CHARS, SOURCES_DIR, IMAGE_EXTENSIONS, TRANSCRIPT_EXTENSIONS, resolveMaxSourceChars } from "../utils/constants.js";
import * as output from "../utils/output.js";
import { verbose } from "../utils/output.js";
import ingestWeb from "../ingest/web.js";
import ingestFile from "../ingest/file.js";
import ingestPdf from "../ingest/pdf.js";
import ingestImage from "../ingest/image.js";
import ingestTranscript, { isYoutubeUrl } from "../ingest/transcript.js";
import type { IngestResult, SourceType } from "../utils/types.js";

/** Check whether a source string looks like a URL. */
function isUrl(source: string): boolean {
  return source.startsWith("http://") || source.startsWith("https://");
}

/** Number of bytes to peek at when sniffing .txt content for transcript signals. */
const TXT_SNIFF_BYTES = 2048;

/**
 * Regex for a speaker-tag line: captures the speaker name before the colon.
 * Allows names up to ~40 chars with letters, spaces, dots, apostrophes, hyphens.
 * The `gm` flags let us find ALL occurrences in the sample.
 */
const SPEAKER_TAG_PATTERN = /^([A-Z][a-zA-Z .'-]{0,40}):\s/gm;

/**
 * Regex for a bare timestamp at the start of a line (allowing leading
 * whitespace): "H:MM", "HH:MM", or "HH:MM:SS". Anchored to line starts so
 * incidental times in prose (e.g. "the meeting at 3:00 was productive")
 * don't trip the transcript heuristic.
 */
const TIMESTAMP_PATTERN = /^\s*\d{1,2}:\d{2}(:\d{2})?/;

/** Minimum number of timestamp-like matches to treat a file as a transcript. */
const MIN_TIMESTAMP_MATCHES = 3;

/**
 * Minimum number of times a single speaker name must appear to signal dialogue
 * (rules out one-off section headers like "Summary:" that appear only once).
 */
const MIN_SPEAKER_REPEAT_COUNT = 2;

/**
 * Minimum number of distinct speaker names required alongside the repeat
 * condition (rules out single-speaker monologues).
 */
const MIN_DISTINCT_SPEAKERS = 2;

/**
 * Count how many times each speaker name appears in the collected tag matches.
 * Returns a Map from name → occurrence count.
 */
function countSpeakerOccurrences(sample: string): Map<string, number> {
  const counts = new Map<string, number>();
  // Reset lastIndex since SPEAKER_TAG_PATTERN has the `g` flag.
  SPEAKER_TAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SPEAKER_TAG_PATTERN.exec(sample)) !== null) {
    const name = match[1].trim();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

/**
 * Decide whether speaker-tag occurrences in a sample look like dialogue.
 *
 * A file passes when both of the following are true:
 *  - At least {@link MIN_DISTINCT_SPEAKERS} distinct speaker names appear.
 *  - At least one name appears {@link MIN_SPEAKER_REPEAT_COUNT}+ times,
 *    indicating back-and-forth turns rather than a list of section headers
 *    (e.g. "Summary: …", "Details: …") where every label is unique.
 */
function hasSpeakerDialoguePattern(sample: string): boolean {
  const counts = countSpeakerOccurrences(sample);

  const distinctSpeakers = counts.size;
  const hasEnoughSpeakers = distinctSpeakers >= MIN_DISTINCT_SPEAKERS;

  const hasRepeatedSpeaker = [...counts.values()].some(
    (n) => n >= MIN_SPEAKER_REPEAT_COUNT,
  );

  return hasEnoughSpeakers && hasRepeatedSpeaker;
}

/**
 * Peek at the first {@link TXT_SNIFF_BYTES} of a plain-text file and decide
 * whether it looks like a conversation transcript.
 *
 * Heuristic: at least one of the following must be true in the sampled content:
 *
 *  1. **Speaker-tag dialogue pattern** — lines of the form "Name: …" where:
 *     - At least {@link MIN_DISTINCT_SPEAKERS} distinct names appear, AND
 *     - At least one name appears {@link MIN_SPEAKER_REPEAT_COUNT}+ times.
 *     This rejects lone section headers ("Summary: …") and lists of unique
 *     labels ("Summary:", "Details:", "Notes:") that have no repetition, while
 *     accepting real back-and-forth dialogue ("Alice: …\nBob: …\nAlice: …").
 *
 *  2. **Timestamp density** — three or more bare timestamp patterns (e.g.
 *     "01:23" / "1:23:45"), the signature of time-coded scripts or subtitles.
 *
 * When neither signal fires the caller routes the file as a generic text file.
 *
 * @param filePath - Absolute or relative path to the .txt file.
 * @returns `true` when transcript signals are detected, `false` otherwise.
 */
async function looksLikeTxtTranscript(filePath: string): Promise<boolean> {
  const raw = await readFile(filePath, "utf-8");
  const sample = raw.slice(0, TXT_SNIFF_BYTES);

  if (hasSpeakerDialoguePattern(sample)) return true;

  const timestampMatches = sample.match(new RegExp(TIMESTAMP_PATTERN.source, "gm"));
  return (timestampMatches?.length ?? 0) >= MIN_TIMESTAMP_MATCHES;
}

/** Truncate result including whether truncation occurred and original length. */
interface TruncateResult {
  content: string;
  truncated: boolean;
  originalChars: number;
}

/**
 * Truncate content that exceeds the character limit, logging a warning that
 * names how much was dropped. The limit comes from `LLMWIKI_MAX_SOURCE_CHARS`
 * when it is set, so a long document can be kept whole.
 */
export function enforceCharLimit(
  content: string,
  maxChars: number = resolveMaxSourceChars()
): TruncateResult {
  if (content.length <= maxChars) {
    return { content, truncated: false, originalChars: content.length };
  }

  const omitted = content.length - maxChars;
  output.status(
    "!",
    output.warn(
      `Content truncated from ${content.length.toLocaleString()} to ${maxChars.toLocaleString()} characters (${omitted.toLocaleString()} omitted).`
    )
  );
  return {
    content: content.slice(0, maxChars),
    truncated: true,
    originalChars: content.length,
  };
}

/** Reject empty content and warn when content is trivially short. */
function enforceMinContent(content: string): void {
  const length = content.trim().length;

  if (length === 0) {
    throw new Error(
      "No readable content could be extracted from the source."
    );
  }

  if (length < MIN_SOURCE_CHARS) {
    output.status(
      "!",
      output.warn(
        `Content seems very short (${length} chars, minimum recommended is ${MIN_SOURCE_CHARS}).`
      )
    );
  }
}

/**
 * Determine the source type for a given source string.
 *
 * For `.txt` files, content-sniffing is used instead of a pure extension check.
 * The file's first {@link TXT_SNIFF_BYTES} bytes are inspected for transcript
 * signals (speaker-tag lines or repeated timestamps). Only when both heuristics
 * fail is the file routed to the generic `file` adapter. `.vtt` and `.srt` are
 * always treated as transcripts regardless of content.
 *
 * @param source - A URL, local file path, or image path.
 * @returns The detected SourceType.
 */
export async function detectSourceType(source: string): Promise<SourceType> {
  if (!isUrl(source)) {
    const ext = path.extname(source).toLowerCase();
    if (ext === ".pdf") return "pdf";
    if (IMAGE_EXTENSIONS.has(ext)) return "image";
    if (TRANSCRIPT_EXTENSIONS.has(ext)) return "transcript";
    if (ext === ".txt") {
      const isTranscript = await looksLikeTxtTranscript(source);
      return isTranscript ? "transcript" : "file";
    }
    return "file";
  }

  if (isYoutubeUrl(source)) return "transcript";
  return "web";
}

/** Build the full markdown document with frontmatter. */
export function buildDocument(
  title: string,
  source: string,
  result: TruncateResult,
  sourceType?: SourceType,
): string {
  const meta: Record<string, unknown> = {
    title,
    source,
    ingestedAt: new Date().toISOString(),
  };
  if (sourceType !== undefined) {
    meta.sourceType = sourceType;
  }
  if (result.truncated) {
    meta.truncated = true;
    meta.originalChars = result.originalChars;
  }
  const frontmatter = buildFrontmatter(meta);

  return `${frontmatter}\n\n${result.content}\n`;
}

/** Fetch content from the appropriate ingestion module based on source type. */
async function fetchContent(
  source: string,
  sourceType: SourceType,
): Promise<{ title: string; content: string }> {
  switch (sourceType) {
    case "web":
      return ingestWeb(source);
    case "pdf":
      return ingestPdf(source);
    case "image":
      return ingestImage(source);
    case "transcript":
      return ingestTranscript(source);
    case "file":
      return ingestFile(source);
  }
}

/**
 * Append a root-bound ingest entry to the activity journal (`log.md`).
 * Shared by `ingestSource` and `ingestTextSource` so both ingest paths journal
 * identically: under the project `root` (not cwd) with a root-relative `Saved`
 * path, keeping the entry portable regardless of the caller's working directory.
 */
async function journalIngest(
  root: string,
  title: string,
  source: string,
  savedPath: string,
  charCount: number,
): Promise<void> {
  await appendLog(root, "ingest", title, {
    details: [
      `Source: ${source}`,
      `Saved: ${journalSavedPath(savedPath)}`,
      `Chars: ${charCount.toLocaleString()}`,
    ],
  });
}

/** The two project steps one ingest takes, in order. No member takes a project root. */
export interface IngestProjectSteps {
  /** Save the document under the project gate; resolves to where it landed and whether bytes changed. */
  save(title: string, document: string, source: string): ReturnType<typeof saveSourceUnderProjectGate>;
  /** Journal one real write; never asked for an unchanged re-ingest. */
  journal(title: string, source: string, savedPath: string, charCount: number): Promise<void>;
}

/** LOCAL DISK. The incumbent gated save and journal append for `root`, each called when asked. */
function localIngestSteps(root: string): IngestProjectSteps {
  return {
    save: (title, document, source) => saveSourceUnderProjectGate(root, title, document, source),
    journal: (title, source, savedPath, charCount) => journalIngest(root, title, source, savedPath, charCount),
  };
}

/** One prepared ingest: the document to save and what the result reports about it. */
interface PreparedIngest {
  title: string;
  source: string;
  document: string;
  extracted: TruncateResult;
  sourceType: SourceType;
}

/**
 * The tail both entries share: save, then (optionally) note where it landed,
 * then journal only a real write, then the result.
 */
async function saveThenJournal(
  steps: IngestProjectSteps, prepared: PreparedIngest, onSaved?: (savedPath: string) => void,
): Promise<IngestResult> {
  const { title, source, document, extracted, sourceType } = prepared;
  const { path: savedPath, writeStatus } = await steps.save(title, document, source);
  onSaved?.(savedPath);

  // Journal only real writes — a no-op re-ingest must not append a log line.
  if (writeStatus !== "unchanged") {
    await steps.journal(title, source, savedPath, extracted.content.length);
  }

  return {
    filename: path.basename(savedPath),
    charCount: extracted.content.length,
    truncated: extracted.truncated,
    source,
    sourceType,
    writeStatus,
  };
}

/** Format the root-relative source reference recorded in the Markdown journal. */
export function journalSavedPath(savedPath: string, pathApi = path): string {
  return `${SOURCES_DIR}/${pathApi.basename(savedPath)}`;
}

/**
 * Programmatic ingest entry point. Identical fetch + write logic to the CLI
 * command but returns a structured IngestResult instead of writing to stdout.
 * Used by the MCP server's ingest_source tool.
 *
 * @param source - A URL (http/https), YouTube URL, local file, PDF, or image path.
 * @returns Saved filename, character count, truncation flag, source URI, and detected source type.
 */
export async function ingestSource(root: string, source: string): Promise<IngestResult> {
  return ingestSourceWith(localIngestSteps(root), source);
}

/** {@link ingestSource} over {@link IngestProjectSteps}: THE ONE BODY. Detect, fetch, limit, document, then save and journal. */
export async function ingestSourceWith(steps: IngestProjectSteps, source: string): Promise<IngestResult> {
  const sourceType = await detectSourceType(source);
  output.status("*", output.info(`Ingesting [${sourceType}]: ${source}`));
  verbose(`source type: ${sourceType}`);

  const { title, content } = await fetchContent(source, sourceType);
  verbose(`fetched: ${content.length} chars`);

  const result = enforceCharLimit(content);
  enforceMinContent(result.content);
  const document = buildDocument(title, source, result, sourceType);
  return saveThenJournal(steps, { title, source, document, extracted: result, sourceType },
    (savedPath) => verbose(`saved: ${savedPath} (${result.content.length} chars extracted)`));
}

/** Input shape for raw-text ingestion. */
export interface IngestTextInput { title: string; text: string; source?: string }

/**
 * Ingest raw text directly into the wiki sources directory.
 *
 * When `source` is omitted a deterministic synthetic identity
 * `manual:<sha256(title,text)>` is derived so that identical content is
 * idempotent and differing content coexists (mirrors saveSource collision rules).
 * The hash is fed a length-prefixed title so the title/text boundary is
 * unambiguous — a raw separator (newline) or bare concatenation would let a
 * boundary-shifted pair collide (e.g. title="a",text="b" vs title="ab",text="").
 *
 * @param root - Absolute path to the wiki root directory.
 * @param input - Title, raw text body, and optional explicit source identity.
 * @returns Structured ingest result with filename, char count, and source URI.
 */
export async function ingestTextSource(root: string, input: IngestTextInput): Promise<IngestResult> {
  return ingestTextSourceWith(localIngestSteps(root), input);
}

/** {@link ingestTextSource} over {@link IngestProjectSteps}: THE ONE BODY. Identity, limit, document, then save and journal. */
export async function ingestTextSourceWith(steps: IngestProjectSteps, input: IngestTextInput): Promise<IngestResult> {
  const digest = createHash("sha256")
    .update(`${input.title.length}\n`)
    .update(input.title)
    .update(input.text)
    .digest("hex");
  const source = input.source ?? `manual:${digest}`;
  const result = enforceCharLimit(input.text);
  enforceMinContent(result.content);
  const document = buildDocument(input.title, source, result, "file");
  return saveThenJournal(steps, { title: input.title, source, document, extracted: result, sourceType: "file" });
}

/**
 * Ingest a source and save it to the sources/ directory.
 * @param source - A URL (http/https), YouTube URL, local file, PDF, or image path.
 */
export default async function ingest(source: string): Promise<void> {
  const cwd = process.cwd();
  const result = await ingestSource(cwd, source);
  const savedPath = path.join(cwd, SOURCES_DIR, result.filename);

  output.status(
    "+",
    output.success(`Saved ${output.bold(result.filename)} → ${output.source(savedPath)}`)
  );
  output.status("→", output.dim("Next: llmwiki compile"));
}

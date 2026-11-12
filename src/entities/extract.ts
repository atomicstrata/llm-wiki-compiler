/**
 * @file src/entities/extract.ts
 * @description Read sources for records of the opted-in entity types, one model
 * call per source chunk, and keep the answers in a cache.
 *
 * A source longer than one prompt is read in chunks, each shown with the file's
 * own line numbers, so a long chat month is read to its end rather than cut off.
 * Each chunk's answer is keyed by a hash of the schema's structural digest and
 * the chunk's numbered text, so a source that grows at its end (a chat month)
 * re-reads only its changed last chunk, and a schema change re-reads everything.
 *
 * A compile whose sources and schema structure are unchanged makes no calls; a
 * removed source drops out. A source whose extraction fails keeps its previous
 * answers, marked for a retry, so one failed call never removes pages; the
 * failure is reported.
 */

import { createHash } from "node:crypto";
import pLimit from "p-limit";
import type { LineRange } from "../compiler/source-excerpt.js";
import { extractionTool, structuralDigest, type ExtractableType } from "./schema.js";
import type { Mention } from "./identity.js";

/** Characters of numbered source text one extraction call carries. */
const CHUNK_CHARS = 60_000;
/** Output tokens one extraction answer may use: a busy chunk lists many records, each with line ranges. */
const EXTRACTION_MAX_TOKENS = 16_000;

/** One record as one source names it. */
export interface ExtractedRecord {
  /** Who the record is: the fullest correct name the source supports. */
  name: string;
  /** Every way the source writes it (nicknames, misspellings, "mama"), as written. */
  writtenAs?: string[];
  fields: Record<string, unknown>;
  lines: LineRange[];
}

/** One chunk's answer, keyed by the hash of the digest and the chunk's numbered text. */
export interface ChunkExtraction {
  hash: string;
  records: Record<string, ExtractedRecord[]>;
}

/** One source's answers. An empty `hash` marks answers kept after a failed read, to be retried. */
export interface SourceExtraction {
  hash: string;
  chunks: ChunkExtraction[];
}

/** The extraction cache: answers per source, for one structural digest. */
export interface ExtractionCache {
  digest: string;
  sources: Record<string, SourceExtraction>;
}

/** One extraction request. */
export interface ExtractRequest {
  system: string;
  messages: { role: "user"; content: string }[];
  tools: ReturnType<typeof extractionTool>[];
  maxTokens?: number;
}

/** The reads and the model call extraction composes. */
export interface ExtractSteps {
  readSource(file: string): Promise<string>;
  complete(request: ExtractRequest): Promise<string>;
}

/** What a refresh did. */
export interface ExtractResult {
  cache: ExtractionCache;
  extracted: string[];
  errors: string[];
}

/** What one refresh reads and how. */
export interface ExtractRun {
  types: ExtractableType[];
  sources: { file: string; hash: string }[];
  previous: ExtractionCache | null;
  ownerNames: string[];
  concurrency: number;
}

/**
 * Bring the cache up to date with the sources: re-read every source whose hash
 * or the schema structure changed (only its changed chunks), drop removed ones,
 * keep the rest.
 */
export async function refreshExtractions(steps: ExtractSteps, run: ExtractRun): Promise<ExtractResult> {
  const digest = structuralDigest(run.types);
  const result: ExtractResult = { cache: { digest, sources: {} }, extracted: [], errors: [] };
  const limit = pLimit(run.concurrency);
  await Promise.all(run.sources.map((source) => limit(() => refreshSource(steps, { ...run, digest, ...source }, result))));
  return result;
}

/** Bring one source's entry up to date in `result.cache`, keeping its previous answers when the read fails. */
async function refreshSource(steps: ExtractSteps, job: SourceJob, result: ExtractResult): Promise<void> {
  const prior = job.previous?.sources[job.file];
  if (job.previous?.digest === job.digest && prior?.hash === job.hash) { result.cache.sources[job.file] = prior; return; }
  try {
    const { chunks, calls } = await extractSource(steps, job, prior?.chunks ?? []);
    result.cache.sources[job.file] = { hash: job.hash, chunks };
    if (calls > 0) result.extracted.push(job.file);
  } catch (error) {
    keepAfterFailure(job.file, prior, error, result);
  }
}

/** Keep a source's previous answers after a failed read, marked for a retry, and report the failure. */
function keepAfterFailure(file: string, prior: SourceExtraction | undefined, error: unknown, result: ExtractResult): void {
  // An empty hash never matches, so the next compile retries the source; until then its records stand.
  if (prior) result.cache.sources[file] = { hash: "", chunks: prior.chunks };
  result.errors.push(`Records not read from ${file}: ${error instanceof Error ? error.message : String(error)}`);
}

/** What one source's extraction needs besides the steps. */
type SourceJob = Pick<ExtractRun, "types" | "ownerNames" | "previous"> & {
  digest: string;
  file: string;
  /** The source's current hash. */
  hash: string;
};

/** Every chunk's answer for one source, reusing `priorChunks` whose hash still matches; and how many calls it took. */
async function extractSource(steps: ExtractSteps, job: SourceJob, priorChunks: ChunkExtraction[]): Promise<{ chunks: ChunkExtraction[]; calls: number }> {
  const lines = (await steps.readSource(job.file)).split("\n");
  const known = new Map(priorChunks.map((chunk) => [chunk.hash, chunk]));
  const chunks: ChunkExtraction[] = [];
  let calls = 0;
  for (const chunk of numberedChunks(lines)) {
    const hash = createHash("sha256").update(job.digest).update("\0").update(chunk).digest("hex").slice(0, 16);
    const reused = known.get(hash);
    if (reused) { chunks.push(reused); continue; }
    const answer = await steps.complete(extractionRequest(job.types, job.file, chunk, job.ownerNames));
    calls++;
    chunks.push({ hash, records: parseRecords(answer, job.types, lines.length) });
  }
  return { chunks, calls };
}

/** The source as numbered lines, split into chunks of at most {@link CHUNK_CHARS}. */
function numberedChunks(lines: string[]): string[] {
  const width = String(lines.length).length;
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  lines.forEach((line, index) => {
    const row = `${String(index + 1).padStart(width)} | ${line}`;
    if (size + row.length > CHUNK_CHARS && current.length > 0) { chunks.push(current.join("\n")); current = []; size = 0; }
    current.push(row);
    size += row.length + 1;
  });
  if (current.length > 0) chunks.push(current.join("\n"));
  return chunks;
}

/** The request for one chunk: what to list, how to name it, the owner to leave out, and the numbered text. */
export function extractionRequest(types: ExtractableType[], file: string, chunk: string, ownerNames: string[]): ExtractRequest {
  const kinds = types.map(({ type, def, fields }) => {
    const guidance = fields.map(([name]) => def.extract.fields?.[name] ? `  - ${name}: ${def.extract.fields[name]}` : "").filter(Boolean);
    return [`- ${type}: ${def.extract.description}`, ...guidance].join("\n");
  }).join("\n");
  const ownerName = ownerNames[0] ?? "the owner";
  const owner = ownerNames.length > 0 ? `\nThe owner of these records is ${ownerNames.join(" / ")}; never list the owner.` : "";
  const system = `List every record of each kind below that the source names.
${kinds}
One record per person. name: who it is. Use a fuller or corrected name only when the source itself makes clear who it is; if unsure, keep the name as written.
List someone the source does not name only when a family relation identifies them (mama, my brother), named by that relation to the person it belongs to, e.g. "${ownerName}'s mother" or "Alex's brother". Skip other unnamed people.
writtenAs: every way the source writes their name, exactly as written.
Use null for anything the source does not say. For lines, give the line numbers shown where the record is mentioned or described.${owner}`;
  return { system, messages: [{ role: "user", content: `--- SOURCE: ${file} ---\n\n${chunk}` }], tools: [extractionTool(types)], maxTokens: EXTRACTION_MAX_TOKENS };
}

/** The records in a model answer, keeping only named records with valid lines inside the file. */
export function parseRecords(answer: string, types: ExtractableType[], lineCount: number): Record<string, ExtractedRecord[]> {
  const parsed = JSON.parse(answer) as Record<string, unknown>;
  return Object.fromEntries(types.map(({ type, fields }) => {
    const items = Array.isArray(parsed[type]) ? parsed[type] as Record<string, unknown>[] : [];
    const records = items.flatMap((item) => {
      const name = typeof item.name === "string" ? item.name.trim() : "";
      const lines = (Array.isArray(item.lines) ? item.lines as LineRange[] : [])
        .filter((range) => Number.isInteger(range?.start) && Number.isInteger(range?.end) && range.start >= 1 && range.start <= range.end && range.end <= lineCount);
      if (!name || lines.length === 0) return [];
      const writtenAs = spellings(item.writtenAs);
      return [{ name, writtenAs, fields: Object.fromEntries(fields.map(([field]) => [field, item[field] ?? null])), lines }];
    });
    return [type, records];
  }));
}

/** An address rather than a name, which is never kept as a spelling. */
const ADDRESS = /@|:\/\//;
/** A possessive ending after a lowercase letter ("Ben’s", "parents’"), which is not part of the name; "O'S" is left alone. */
const POSSESSIVE = /(?<=\p{Ll})['’]s?$/u;

/** A spelling as kept: trimmed, without a possessive ending. */
export function cleanSpelling(form: string): string {
  return form.trim().replace(POSSESSIVE, "").trim();
}

/** The distinct names in a `writtenAs` answer: trimmed, without possessive endings, and without addresses. */
function spellings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const forms = value.filter((form): form is string => typeof form === "string" && !ADDRESS.test(form))
    .map(cleanSpelling).filter(Boolean);
  return [...new Set(forms)];
}

/** Every mention of `type` across the cached sources, in file order. */
export function mentionsOf(cache: ExtractionCache, type: string): Mention[] {
  return Object.entries(cache.sources).sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([file, entry]) => entry.chunks.flatMap((chunk) => (chunk.records[type] ?? []).map((record) => ({ file, ...record }))));
}

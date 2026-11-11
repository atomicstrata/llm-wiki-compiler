/**
 * @file src/entities/extract.ts
 * @description Read sources for records of the opted-in entity types, one model
 * call per source chunk, and keep the answers in a cache keyed by each source's
 * hash and the schema's structural digest.
 *
 * A compile whose sources and schema structure are unchanged makes no calls.
 * A changed source is re-read in full; a removed one drops out. A source whose
 * extraction fails is left OUT of the cache rather than kept with answers for
 * text it no longer has, so its records disappear until a later compile reads
 * it again, and the failure is reported.
 *
 * A source longer than one prompt is read in chunks, each shown with the file's
 * own line numbers, so a long chat month is read to its end rather than cut off.
 */

import pLimit from "p-limit";
import type { LineRange } from "../timeline/event-days.js";
import { extractionTool, structuralDigest, type ExtractableType } from "./schema.js";

/** Characters of numbered source text one extraction call carries. */
const CHUNK_CHARS = 60_000;

/** One record as one source names it. */
export interface ExtractedRecord {
  name: string;
  fields: Record<string, unknown>;
  lines: LineRange[];
}

/** The extraction cache: answers per source, valid for one structural digest. */
export interface ExtractionCache {
  digest: string;
  sources: Record<string, { hash: string; records: Record<string, ExtractedRecord[]> }>;
}

/** One extraction request. */
export interface ExtractRequest {
  system: string;
  messages: { role: "user"; content: string }[];
  tools: ReturnType<typeof extractionTool>[];
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

/**
 * Bring the cache up to date with the sources: re-read every source whose hash
 * or the schema structure changed, drop removed ones, keep the rest.
 */
export async function refreshExtractions(
  steps: ExtractSteps, types: ExtractableType[], sources: { file: string; hash: string }[],
  previous: ExtractionCache | null, ownerNames: string[], concurrency: number,
): Promise<ExtractResult> {
  const digest = structuralDigest(types);
  const kept = previous?.digest === digest ? previous.sources : {};
  const cache: ExtractionCache = { digest, sources: {} };
  const result: ExtractResult = { cache, extracted: [], errors: [] };
  const limit = pLimit(Math.max(1, concurrency));
  await Promise.all(sources.map((source) => limit(async () => {
    if (kept[source.file]?.hash === source.hash) { cache.sources[source.file] = kept[source.file]; return; }
    try {
      const records = await extractSource(steps, types, source.file, ownerNames);
      cache.sources[source.file] = { hash: source.hash, records };
      result.extracted.push(source.file);
    } catch (error) {
      result.errors.push(`Records not read from ${source.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  })));
  return result;
}

/** Every record one source names, merged across its chunks. */
async function extractSource(steps: ExtractSteps, types: ExtractableType[], file: string, ownerNames: string[]): Promise<Record<string, ExtractedRecord[]>> {
  const lines = (await steps.readSource(file)).split("\n");
  const records: Record<string, ExtractedRecord[]> = Object.fromEntries(types.map(({ type }) => [type, []]));
  for (const chunk of numberedChunks(lines)) {
    const answer = await steps.complete(extractionRequest(types, file, chunk, ownerNames));
    const parsed = parseRecords(answer, types, lines.length);
    for (const { type } of types) records[type].push(...parsed[type]);
  }
  return records;
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

/** The request for one chunk: what to list, the owner to leave out, and the numbered text. */
export function extractionRequest(types: ExtractableType[], file: string, chunk: string, ownerNames: string[]): ExtractRequest {
  const kinds = types.map(({ type, def, fields }) => {
    const guidance = fields.map(([name]) => def.extract?.fields?.[name] ? `  - ${name}: ${def.extract.fields[name]}` : "").filter(Boolean);
    return [`- ${type}: ${def.extract!.description}`, ...guidance].join("\n");
  }).join("\n");
  const owner = ownerNames.length > 0 ? `\nThe owner of these records is ${ownerNames.join(" / ")}; never list the owner.` : "";
  const system = `List every record of each kind below that the source names.\n${kinds}\nGive each name exactly as written. Use null for anything the source does not say. For lines, give the line numbers shown where the record is mentioned or described.${owner}`;
  return { system, messages: [{ role: "user", content: `--- SOURCE: ${file} ---\n\n${chunk}` }], tools: [extractionTool(types)] };
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
      return [{ name, fields: Object.fromEntries(fields.map(([field]) => [field, item[field] ?? null])), lines }];
    });
    return [type, records];
  }));
}

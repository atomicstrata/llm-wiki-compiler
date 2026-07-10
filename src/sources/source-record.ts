/**
 * @file src/sources/source-record.ts
 * @description The pure (no-I/O) source-record vocabulary shared by the source
 * store: the {@link SourceRecord} shape and its pagination option/result types,
 * the bare-basename id-safety guard, and the frontmatter→record projection.
 *
 * Factored out of `./store.ts` so the I/O entry points (`listSources`,
 * `getSource`, `deleteSource`) stay a thin filesystem layer over these pure
 * helpers — and so the record/guard logic is unit-testable without touching disk.
 */

import { parseFrontmatter } from "../utils/markdown.js";
import { PathSafetyError } from "../viewer/path-safety.js";

/** A single source file under `sources/`, with frontmatter metadata. */
export interface SourceRecord {
  id: string; // basename incl. ".md"
  title: string;
  source: string; // frontmatter `source` identity
  sourceType: string;
  ingestedAt?: string;
  body?: string;
}

/** Options for paginating `listSources` and opting into source bodies. */
export interface ListSourcesOptions {
  cursor?: string;
  limit?: number;
  includeBody?: boolean;
}

/** Result returned by `listSources`. */
export interface ListSourcesResult {
  sources: SourceRecord[];
  cursor?: string;
}

/**
 * Reject anything that isn't a bare `sources/` basename ending in `.md`.
 *
 * Real source IDs are `slug-<hex>.md` (slugified title + collision hash) and
 * never contain `..`, so rejecting any `..` substring is safe and simpler than
 * component-level normalization.
 *
 * @param id - The candidate source id (must be a bare `.md` basename).
 * @throws {PathSafetyError} When the id is empty, not `.md`, or not a bare basename.
 */
export function assertSafeSourceId(id: string): void {
  if (typeof id !== "string" || id.length === 0) throw new PathSafetyError("source id must be a non-empty string");
  if (!id.endsWith(".md")) throw new PathSafetyError(`source id must end in .md: "${id}"`);
  if (id.includes("/") || id.includes("\\") || id.includes("\0") || id.includes(".."))
    throw new PathSafetyError(`source id must be a bare basename: "${id}"`);
}

/**
 * Project a source file's raw content into a {@link SourceRecord}, reading title/
 * source/type/timestamp from frontmatter (with safe fallbacks) and including the
 * body only when requested. Pure: no I/O.
 *
 * @param id - The source id (bare `.md` basename).
 * @param content - The file's raw UTF-8 content.
 * @param includeBody - Whether to attach the parsed body to the record.
 * @returns The projected source record.
 */
export function toRecord(id: string, content: string, includeBody: boolean): SourceRecord {
  const { meta, body } = parseFrontmatter(content);
  return {
    id,
    title: typeof meta.title === "string" ? meta.title : id,
    source: typeof meta.source === "string" ? meta.source : "",
    sourceType: typeof meta.sourceType === "string" ? meta.sourceType : "file",
    ingestedAt: typeof meta.ingestedAt === "string" ? meta.ingestedAt : undefined,
    ...(includeBody ? { body } : {}),
  };
}

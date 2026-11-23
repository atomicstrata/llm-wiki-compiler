/**
 * @file src/relations/store-read.ts
 * @description The READ half of the relation store: parse the append-only
 * JSONL at `wiki/graph/relations.jsonl` into the live set of relations.
 *
 * Durability contract (07 §JSONL Durability And Concurrency):
 *  - The FIRST line is a header carrying `schemaVersion`. A `schemaVersion`
 *    greater than {@link RELATION_STORE_SCHEMA_VERSION} → FAIL CLOSED
 *    ({@link RelationStoreTooNewError}); we do not guess at a future format.
 *  - Every record carries a CHECKSUM, recomputed and compared on read. A bad
 *    checksum or a malformed record BEFORE the final line is interior
 *    corruption → FAIL CLOSED ({@link RelationStoreCorruptError}).
 *  - A torn TRAILING line (an incomplete final append) is TOLERATED and
 *    REPORTED as a `problem` — never silently dropped, never failed on.
 *  - The graph directory's realpath is confined under root before reading; a
 *    symlinked `wiki/graph` fails closed.
 *  - Absent file → empty result.
 *
 * UPDATE SEMANTICS: the store is append-only and an update appends a NEW record
 * with the same `id`. This reader returns the LATEST record per `id` (last wins
 * by file order), so a superseded record is dropped from the live set while
 * remaining on disk for audit.
 */

import path from "path";
import { RELATIONS_FILE, MAX_RELATION_STORE_BYTES } from "../utils/constants.js";
import { splitStoreRecords, type GraphStoreReads } from "../utils/jsonl-store.js";
import type { RelationRef } from "./types.js";
import {
  RELATION_STORE_SCHEMA_VERSION,
  RelationStoreTooNewError,
  RelationStoreCorruptError,
  RelationStoreSymlinkError,
} from "./types.js";
import { parseRecord, verifyChecksum, type BoundRelationRecord, type ReadRelationRecordsResult } from "./record-check.js";
import { diskRelationGraphReads, type RelationGraphReads } from "./graph-reads.js";

export type { BoundRelationRecord, ReadRelationRecordsResult } from "./record-check.js";

/** The outcome of reading the store: live relations plus any tolerated problems. */
export interface ReadRelationsResult {
  /** Latest record per id, in first-seen id order. */
  relations: RelationRef[];
  /** Human-readable notes about tolerated issues (e.g. a torn trailing line). */
  problems: string[];
}

/**
 * Read the raw store file bytes, or null when the file is absent — via the shared
 * {@link readConfinedGraphStore}, which resolves the confined graph dir, opens the
 * leaf NO-FOLLOW (a symlinked leaf fails closed as {@link RelationStoreSymlinkError}),
 * and `fstat`-fails-closed ({@link RelationStoreCorruptError}) above
 * {@link MAX_RELATION_STORE_BYTES} before the whole-file read — so an
 * attacker/sync-controlled multi-GB file cannot exhaust memory.
 */
function readStoreFile(graph: GraphStoreReads): Promise<string | null> {
  return graph.readStore({
    fileName: path.basename(RELATIONS_FILE),
    makeSymlinkError: (reason) => new RelationStoreSymlinkError(reason),
    maxBytes: MAX_RELATION_STORE_BYTES,
    makeOversizeError: (size) =>
      new RelationStoreCorruptError(`store file ${size} bytes exceeds the ${MAX_RELATION_STORE_BYTES}-byte cap`),
  });
}

/**
 * Read the exact raw store bytes (or null when absent) through the graph-store
 * read it is handed — the same confined, no-follow, capped read the parser uses,
 * asked with THIS store's configuration. The store-version upgrade body consumes
 * these bytes to rewrite only the header while preserving every record byte and
 * its order. (It replaces the root-taking `readRelationStoreRaw`, whose only
 * caller was that upgrade.)
 */
export function readRelationStoreRawFrom(graph: GraphStoreReads): Promise<string | null> {
  return readStoreFile(graph);
}

/** Parse and validate the header line, failing closed on an unknown future version. */
function parseHeader(line: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new RelationStoreCorruptError("header line is not valid JSON");
  }
  const header = parsed as { kind?: unknown; schemaVersion?: unknown };
  if (header.kind !== "relation-store-header" || typeof header.schemaVersion !== "number") {
    throw new RelationStoreCorruptError("first line is not a valid store header");
  }
  if (header.schemaVersion > RELATION_STORE_SCHEMA_VERSION) {
    throw new RelationStoreTooNewError(header.schemaVersion, RELATION_STORE_SCHEMA_VERSION);
  }
}

/** Collapse records to the latest per id (last wins), preserving first-seen order. */
function latestPerId(records: BoundRelationRecord[]): BoundRelationRecord[] {
  const byId = new Map<string, BoundRelationRecord>();
  for (const record of records) {
    byId.set(record.ref.id, record);
  }
  return [...byId.values()];
}

/**
 * Parse every record line AFTER the header. A failure on any line except the
 * LAST is interior corruption (fail closed); a failure on the last line is a
 * torn trailing append — tolerated, reported via `problems`.
 */
function parseRecords(lines: string[], problems: string[]): BoundRelationRecord[] {
  const records: BoundRelationRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    const isLast = i === lines.length - 1;
    try {
      records.push(verifyChecksum(parseRecord(lines[i])));
    } catch (err) {
      if (isLast) {
        problems.push(`tolerated torn trailing line: ${(err as Error).message}`);
        break;
      }
      throw err; // interior corruption → fail closed
    }
  }
  return records;
}

/**
 * Read every valid record in file order, carrying any operation binding — the
 * binding-aware read an operation adapter uses to observe append-shaped state by
 * `mutationId`. See the file overview for the full durability contract.
 *
 * @param root - Absolute project root.
 * @returns Every valid record in append order and a list of tolerated problems.
 */
export function readRelationRecords(root: string): Promise<ReadRelationRecordsResult> {
  return readRelationRecordsFrom(diskRelationGraphReads(root));
}

/**
 * {@link readRelationRecords} over a graph-store read: THE ONE BODY. The read is
 * asked with THIS store's configuration (file name, cap and both error
 * factories); nothing is caught, so a rejection leaves as the same error.
 */
export async function readRelationRecordsFrom(graph: RelationGraphReads): Promise<ReadRelationRecordsResult> {
  const segmented = await graph.segmentedRelations?.();
  if (segmented) return segmented.readRecords(); // capped compatibility materializer of the indexed log
  const raw = await readStoreFile(graph); // throws on symlink escape
  const recordLines = splitStoreRecords(raw, parseHeader);
  if (recordLines === null) return { records: [], problems: [] };
  const problems: string[] = [];
  const records = parseRecords(recordLines, problems);
  return { records, problems };
}

/**
 * Read the relation store into the live set of relations plus any tolerated
 * problems. See the file overview for the full durability contract.
 *
 * @param root - Absolute project root.
 * @returns The latest relation per id and a list of tolerated problems.
 */
export function readRelations(root: string): Promise<ReadRelationsResult> {
  return readRelationsFrom(diskRelationGraphReads(root));
}

/** {@link readRelations} over a graph-store read: the latest record per id, in first-seen id order. */
export async function readRelationsFrom(graph: RelationGraphReads): Promise<ReadRelationsResult> {
  const { records, problems } = await readRelationRecordsFrom(graph);
  return { relations: latestPerId(records).map((record) => record.ref), problems };
}

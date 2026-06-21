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

import { readFile, stat } from "fs/promises";
import path from "path";
import { RELATIONS_FILE, MAX_RELATION_STORE_BYTES } from "../utils/constants.js";
import { parseEntityId, EntityIdError } from "../profile/identity.js";
import type { RelationRef, RelationRecord } from "./types.js";
import {
  RELATION_STORE_SCHEMA_VERSION,
  RelationStoreTooNewError,
  RelationStoreCorruptError,
} from "./types.js";
import { recordChecksum, resolveGraphDir } from "./store-record.js";

/** The outcome of reading the store: live relations plus any tolerated problems. */
export interface ReadRelationsResult {
  /** Latest record per id, in first-seen id order. */
  relations: RelationRef[];
  /** Human-readable notes about tolerated issues (e.g. a torn trailing line). */
  problems: string[];
}

/**
 * Read the raw store file bytes, or null when the file is absent. STATs the file
 * FIRST and fails closed ({@link RelationStoreCorruptError}) when it exceeds
 * {@link MAX_RELATION_STORE_BYTES}, so an attacker/sync-controlled multi-GB file
 * is rejected before the whole-file read could exhaust memory.
 */
async function readStoreFile(root: string): Promise<string | null> {
  const { dir, exists } = await resolveGraphDir(root); // throws on symlink escape
  if (!exists) return null;
  const file = path.join(dir, path.basename(RELATIONS_FILE));
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return null; // dir exists but file does not → no relations yet
  }
  if (size > MAX_RELATION_STORE_BYTES) {
    throw new RelationStoreCorruptError(
      `store file ${size} bytes exceeds the ${MAX_RELATION_STORE_BYTES}-byte cap`,
    );
  }
  return readFile(file, "utf-8");
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

/** Split a record line into its {@link RelationRef} and stored checksum, validating shape. */
function parseRecord(line: string): RelationRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new RelationStoreCorruptError("record line is not valid JSON");
  }
  const rec = parsed as Partial<RelationRecord>;
  const idOk = typeof rec.id === "string" && rec.id.startsWith("rel_");
  if (!idOk || typeof rec.checksum !== "string" || typeof rec.type !== "string") {
    throw new RelationStoreCorruptError("record line is missing required fields");
  }
  return rec as RelationRecord;
}

/**
 * Re-assert both endpoints are slug-safe `<type>/<slug>` ids via
 * {@link parseEntityId} (which validates both halves), symmetrical with the
 * write path's endpoint validation. A well-formed-but-traversal endpoint (e.g.
 * `from: "../../etc/passwd"`) is INTERIOR CORRUPTION, not a benign dangling page,
 * so it fails closed — a future path-deriving consumer cannot inherit a traversal.
 */
function assertEndpointsSlugSafe(ref: RelationRef): void {
  try {
    parseEntityId(ref.from);
    parseEntityId(ref.to);
  } catch (err) {
    if (err instanceof EntityIdError) {
      throw new RelationStoreCorruptError(`relation ${ref.id} has a non-slug-safe endpoint: ${err.message}`);
    }
    throw err;
  }
}

/** Verify a parsed record's stored checksum + endpoint slug-safety; throw on either. */
function verifyChecksum(record: RelationRecord): RelationRef {
  const { checksum, ...ref } = record;
  if (recordChecksum(ref) !== checksum) {
    throw new RelationStoreCorruptError(`checksum mismatch for relation ${ref.id}`);
  }
  assertEndpointsSlugSafe(ref);
  return ref;
}

/** Collapse records to the latest per id (last wins), preserving first-seen order. */
function latestPerId(records: RelationRef[]): RelationRef[] {
  const byId = new Map<string, RelationRef>();
  for (const ref of records) {
    byId.set(ref.id, ref);
  }
  return [...byId.values()];
}

/**
 * Parse every record line AFTER the header. A failure on any line except the
 * LAST is interior corruption (fail closed); a failure on the last line is a
 * torn trailing append — tolerated, reported via `problems`.
 */
function parseRecords(lines: string[], problems: string[]): RelationRef[] {
  const refs: RelationRef[] = [];
  for (let i = 0; i < lines.length; i++) {
    const isLast = i === lines.length - 1;
    try {
      refs.push(verifyChecksum(parseRecord(lines[i])));
    } catch (err) {
      if (isLast) {
        problems.push(`tolerated torn trailing line: ${(err as Error).message}`);
        break;
      }
      throw err; // interior corruption → fail closed
    }
  }
  return refs;
}

/**
 * Read the relation store into the live set of relations plus any tolerated
 * problems. See the file overview for the full durability contract.
 *
 * @param root - Absolute project root.
 * @returns The latest relation per id and a list of tolerated problems.
 */
export async function readRelations(root: string): Promise<ReadRelationsResult> {
  const raw = await readStoreFile(root); // throws on symlink escape
  if (raw === null || raw.trim() === "") return { relations: [], problems: [] };
  const lines = raw.split("\n").filter((line) => line.length > 0);
  parseHeader(lines[0]);
  const problems: string[] = [];
  const refs = parseRecords(lines.slice(1), problems);
  return { relations: latestPerId(refs), problems };
}

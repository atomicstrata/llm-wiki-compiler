/**
 * @file src/scale/downgrade-verify.ts
 * @description The proof that one scale-down export is what the smaller
 * layout will read: its bytes, parsed by the INCUMBENT strict reader of that
 * file, yield exactly the exported records.
 *
 * - events: the incumbent event body over the bytes (never the segmented
 *   dispatch), with the project's sealed head anchor: no problem at all (no
 *   torn line, chain break or anchor mismatch), the exported record count,
 *   and the last record's digest equal to the segmented log's head;
 * - relations: the incumbent relation body, no problem, the record count;
 * - a workspace catalog: the incumbent canonical, lineage-validating parser;
 * - the compile state: the incumbent classifier reads it `ok`, and
 *   re-serializes it to the very same text;
 * - vectors: the incumbent container decoder and the v3 search validation,
 *   with no record dropped and the exported record count.
 * Each verifier takes the bytes, so the same proof runs over a staged file and
 * over the installed one. Any failure is `downgrade_export_mismatch`.
 */

import { eventPrevHash } from "../events/event-digest.js";
import { diskHeadAnchorSources } from "../events/head-anchor.js";
import { readEventsFrom } from "../events/store-read.js";
import { parseCatalogBytes } from "../operation-bundles/catalog-record.js";
import { readRelationRecordsFrom } from "../relations/store-read.js";
import { decodeBinaryStore } from "../utils/embeddings-binary.js";
import { parseEmbeddingStore } from "../utils/embeddings-storage.js";
import { validateV3ForSearch } from "../utils/embeddings-store.js";
import type { GraphStoreReads } from "../utils/jsonl-store.js";
import { classifyStateText, serializeState } from "../utils/state-shape.js";
import type { ExportedEvents } from "./downgrade-export-history.js";
import { DowngradeExportError, type ExportedFile } from "./downgrade-sink.js";

/** Refuse with `detail` unless `holds`. */
function check(holds: boolean, relPath: string, detail: string): void {
  if (!holds) throw new DowngradeExportError("downgrade_export_mismatch", `${relPath}: ${detail}`);
}

/** A graph read serving exactly `body` (the incumbent file body runs over it, not the segmented dispatch). */
function bytesGraph(body: Buffer): GraphStoreReads {
  return { readStore: async () => body.toString("utf8") };
}

/** Verify exported event-log bytes against the export and the project's sealed head anchor. */
export async function verifyEventsBytes(root: string, body: Buffer, exported: ExportedEvents): Promise<void> {
  const { events, problems } = await readEventsFrom({ graph: bytesGraph(body), ...diskHeadAnchorSources(root) });
  check(problems.length === 0, exported.relPath, `the incumbent reader reports ${problems.slice(0, 3).join("; ")}`);
  check(events.length === exported.records, exported.relPath, `${events.length} events read, ${exported.records} exported`);
  const head = events.length === 0 ? null : eventPrevHash(events[events.length - 1]!);
  check(head === exported.headDigest, exported.relPath, "the last event is not the segmented log's head");
}

/** Verify exported relation-log bytes. */
export async function verifyRelationsBytes(body: Buffer, exported: ExportedFile): Promise<void> {
  const { records, problems } = await readRelationRecordsFrom(bytesGraph(body));
  check(problems.length === 0, exported.relPath, `the incumbent reader reports ${problems.slice(0, 3).join("; ")}`);
  check(records.length === exported.records, exported.relPath, `${records.length} relations read, ${exported.records} exported`);
}

/** Verify exported workspace catalog bytes. */
export function verifyCatalogBytes(body: Buffer, exported: ExportedFile): void {
  let records: number;
  try { records = parseCatalogBytes(body).length; } catch (error) { return check(false, exported.relPath, error instanceof Error ? error.message : String(error)); }
  check(records === exported.records, exported.relPath, `${records} catalog records read, ${exported.records} exported`);
}

/** Verify exported compile-state bytes. */
export function verifyCompileStateBytes(body: Buffer, exported: ExportedFile): void {
  const text = body.toString("utf8");
  const classified = classifyStateText(text);
  check(classified.status === "ok", exported.relPath, `the incumbent classifier reads it ${classified.status}`);
  check(serializeState(classified.state) === text, exported.relPath, "it does not re-serialize to the same text");
  check(Object.keys(classified.state.sources).length === exported.records, exported.relPath, "the source count differs");
}

/** Verify exported binary embedding container bytes. */
export function verifyVectorBytes(body: Buffer, exported: ExportedFile): void {
  let parsed;
  try { parsed = parseEmbeddingStore(decodeBinaryStore(body)); } catch (error) { return check(false, exported.relPath, error instanceof Error ? error.message : String(error)); }
  check(parsed?.version === 3, exported.relPath, "it is not a version 3 embedding store");
  const validation = validateV3ForSearch(parsed!);
  check(validation.available && validation.droppedIds.length === 0, exported.relPath, "it fails the incumbent search validation");
  const store = parsed!.store as { entries: unknown[]; chunks?: unknown[] };
  check(store.entries.length + (store.chunks?.length ?? 0) === exported.records, exported.relPath, "the record count differs");
}

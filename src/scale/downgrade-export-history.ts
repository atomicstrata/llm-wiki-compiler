/**
 * @file src/scale/downgrade-export-history.ts
 * @description The scale-down EXPORTS of an active `local-indexed` project's
 * history and compile state: each segmented authority streamed, in its own
 * record order, into the exact incumbent single-file format the smaller
 * layout reads (`./downgrade-sink.ts` for the counting and writing sinks).
 *
 * - EVENTS: the header at the log's recorded header version, then every
 *   stored `EventRecord` (checksum and `prevHash` included) as one JSON line,
 *   in index order. The records are the incumbent records, so the chain and
 *   the sealed head anchor carry over unchanged.
 * - RELATIONS: the header at the log's header version, then every stored
 *   `RelationRecord` (bindings and checksums included), in index order.
 * - WORKSPACE OPERATION CATALOG: each stored `CatalogRecord` as its canonical
 *   bytes plus a newline, in index order. An empty catalog has no file (the
 *   incumbent parser refuses an empty one).
 * - COMPILE STATE (only when the segmented compile state is the authority):
 *   the materialization the compile-state route already serves, serialized by
 *   the incumbent `serializeState`. The materialization keeps its own budget
 *   (`compile_state_too_large`), and the file keeps the cap a later indexed
 *   preparation imports `state.json` within, so the export round trips.
 *
 * Every cap is the one the indexed preparation imported the incumbent file
 * within, so an exported file can always be imported again.
 *
 * Every store is opened through the ordinary routed reads, so the caller's
 * scope decides which reads are admitted. Nothing here writes a project file;
 * every result is plain data (no snapshot or iterator escapes).
 */

import { EVENT_STORE_BASE_WRITE_VERSION } from "../events/types.js";
import { eventHeaderLine } from "../events/store-record.js";
import { indexKey } from "../history/contracts.js";
import { EVENT_PREFIX, openEventLog, readyEventLogMeta } from "../history/events-log.js";
import { CATALOG_RECORD_PREFIX, legacyCatalogPath, openOperationCatalog, readyOperationCatalogMeta } from "../history/operation-catalog.js";
import { openRelationLog, readyRelationLogMeta, RELATION_PREFIX } from "../history/relations-log.js";
import { normalizeCatalogRecord, type CatalogRecord } from "../operation-bundles/catalog-record.js";
import { MAX_CATALOG_FILE_BYTES } from "../operation-bundles/constants.js";
import { headerLine as relationHeaderLine } from "../relations/store-record.js";
import { RELATION_STORE_BASE_WRITE_VERSION } from "../relations/types.js";
import type { SegmentStore } from "../segments/store.js";
import { compileStateMetaOf, MAX_STATE_FILE_BYTES } from "../cstate/contracts.js";
import { materializeCompileState, openCompileState } from "../cstate/store.js";
import { EVENTS_FILE, MAX_EVENT_STORE_BYTES, MAX_RELATION_STORE_BYTES, RELATIONS_FILE, STATE_FILE } from "../utils/constants.js";
import { serializeState } from "../utils/state-shape.js";
import { DowngradeExportError, ExportSink, type ExportedFile } from "./downgrade-sink.js";

/** The events export, with the head digest its last record must carry. */
export interface ExportedEvents extends ExportedFile {
  readonly headDigest: string | null;
}

/** The compile-state export, with the batch run the segmented state last published (not representable in `state.json`). */
export interface ExportedCompileState extends ExportedFile {
  readonly lastRun: string | null;
}

/** A sink for `relPath` under `cap`: writing through `write` when given, else counting. */
export type SinkFactory = (relPath: string, cap: number) => ExportSink;

/** Push every record row under `prefix` in index order as one line each; returns how many. */
async function pushRecords(store: SegmentStore, prefix: string, sink: ExportSink, line: (value: unknown) => string | Buffer): Promise<number> {
  let records = 0;
  for await (const row of store.scan({ prefix })) {
    if (row.k !== indexKey(prefix, records)) throw new DowngradeExportError("downgrade_export_mismatch", `${sink.relPath}: the stored history has a gap at record ${records}`);
    await sink.push(line(row.v));
    records += 1;
  }
  return records;
}

/** Refuse unless the streamed record count is the store's recorded count. */
function assertCount(relPath: string, records: number, expected: number): void {
  if (records !== expected) throw new DowngradeExportError("downgrade_export_mismatch", `${relPath}: ${records} records streamed, the store records ${expected}`);
}

/** Whether a header-versioned log exports no file: empty, never upgraded, and with no incumbent file. */
function noLogFile(count: number, headerVersion: number, baseVersion: number, incumbentAbsent: boolean): boolean {
  return count === 0 && headerVersion === baseVersion && incumbentAbsent;
}

/** Export the segmented event log of `root` as `wiki/graph/events.jsonl`. */
export async function exportEvents(root: string, sinkFor: SinkFactory): Promise<ExportedEvents> {
  const sink = sinkFor(EVENTS_FILE, MAX_EVENT_STORE_BYTES);
  const store = await openEventLog(root);
  const meta = readyEventLogMeta(store);
  if (noLogFile(meta.count, meta.headerVersion, EVENT_STORE_BASE_WRITE_VERSION, meta.legacy.stamp === null)) return { ...sink.absent(), headDigest: null };
  await sink.push(eventHeaderLine(meta.headerVersion));
  const records = await pushRecords(store, EVENT_PREFIX, sink, (value) => `${JSON.stringify(value)}\n`);
  assertCount(EVENTS_FILE, records, meta.count);
  return { ...(await sink.finish(records)), headDigest: meta.headDigest };
}

/** Export the segmented relation log of `root` as `wiki/graph/relations.jsonl`. */
export async function exportRelations(root: string, sinkFor: SinkFactory): Promise<ExportedFile> {
  const sink = sinkFor(RELATIONS_FILE, MAX_RELATION_STORE_BYTES);
  const store = await openRelationLog(root);
  const meta = readyRelationLogMeta(store);
  if (noLogFile(meta.count, meta.headerVersion, RELATION_STORE_BASE_WRITE_VERSION, meta.legacy.stamp === null)) return sink.absent();
  await sink.push(relationHeaderLine(meta.headerVersion));
  const records = await pushRecords(store, RELATION_PREFIX, sink, (value) => `${JSON.stringify(value)}\n`);
  assertCount(RELATIONS_FILE, records, meta.count);
  return sink.finish(records);
}

/** The canonical catalog line of one stored record. */
function catalogLine(value: unknown): Buffer {
  return Buffer.concat([normalizeCatalogRecord(value as CatalogRecord).bytes, Buffer.from("\n")]);
}

/** Export the segmented operation catalog of `workspaceId` as its incumbent catalog file. */
export async function exportWorkspaceCatalog(root: string, workspaceId: string, sinkFor: SinkFactory): Promise<ExportedFile> {
  const relPath = legacyCatalogPath(root, workspaceId);
  const sink = sinkFor(relPath, MAX_CATALOG_FILE_BYTES);
  const store = await openOperationCatalog(root, workspaceId);
  const meta = readyOperationCatalogMeta(store, root, workspaceId);
  if (meta.count === 0) return sink.absent();
  const records = await pushRecords(store, CATALOG_RECORD_PREFIX, sink, catalogLine);
  assertCount(relPath, records, meta.count);
  return sink.finish(records);
}

/** Export the segmented compile state of `root` as `.llmwiki/state.json` (call only when it is the authority). */
export async function exportCompileState(root: string, sinkFor: SinkFactory): Promise<ExportedCompileState> {
  const sink = sinkFor(STATE_FILE, MAX_STATE_FILE_BYTES);
  const meta = compileStateMetaOf(await openCompileState(root));
  const state = await materializeCompileState(root);
  await sink.push(serializeState(state));
  return { ...(await sink.finish(Object.keys(state.sources).length)), lastRun: meta.lastRun };
}

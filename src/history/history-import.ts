/**
 * @file src/history/history-import.ts
 * @description The `history-import` preparation step: copy each incumbent
 * single-file history (events, relations, every workspace operation catalog)
 * into its segmented store, verified, within the incumbent caps.
 *
 * COHERENCE. Each file is captured ONCE (stamp, exact bytes, SHA-256) and
 * parsed from exactly those bytes by the incumbent strict parser (chain for
 * events, checksums for relations, the full lineage replay for catalogs);
 * after parsing, the file's stamp must still match the capture, so the
 * recorded backup is exactly what was imported.
 *
 * ATOMIC, RESUMABLE. Each import publishes in ONE conditional commit, so a
 * crash leaves either nothing (rerun from scratch) or the whole import. A
 * rerun compares EVERY already-imported record with the file's same record
 * and adds only a longer file's new tail; a shrunk, absent or rewritten file
 * parks the step. The files themselves are never written. Runs before
 * activation, so the incumbent readers still see the files as the authority.
 */

import { isDeepStrictEqual } from "node:util";
import { eventPrevHash } from "../events/event-digest.js";
import { diskEventReadSources, readEventsStrictFrom } from "../events/store-read.js";
import { EVENT_STORE_BASE_WRITE_VERSION, EVENT_STORE_OPERATION_VERSION, type EventRecord } from "../events/types.js";
import { parseCatalogBytes, type CatalogRecord } from "../operation-bundles/catalog-record.js";
import { MAX_CATALOG_FILE_BYTES } from "../operation-bundles/constants.js";
import { readRelationRecordsFrom, type BoundRelationRecord } from "../relations/store-read.js";
import { RELATION_STORE_BASE_WRITE_VERSION, RELATION_STORE_OPERATION_VERSION } from "../relations/types.js";
import { sortedByKey, type SegmentRow } from "../segments/contracts.js";
import { storeMayHoldLeaves } from "../segments/io.js";
import type { SegmentStore } from "../segments/store.js";
import { listConfinedDirBounded } from "../utils/confined-dir.js";
import { EVENTS_FILE, MAX_EVENT_STORE_BYTES, MAX_RELATION_STORE_BYTES, RELATIONS_FILE } from "../utils/constants.js";
import type { GraphStoreReads } from "../utils/jsonl-store.js";
import { assertCaptureCurrent, captureLegacy, indexKey, type LegacyCapture } from "./contracts.js";
import { bindingKey, EVENT_PREFIX, eventLogMetaOf, openEventLog } from "./events-log.js";
import { CATALOG_RECORD_PREFIX, catalogRows, legacyCatalogPath, openOperationCatalog, operationCatalogMetaOf } from "./operation-catalog.js";
import { openRelationLog, RELATION_PREFIX, relationLogMetaOf, relationRows } from "./relations-log.js";

/** Most workspaces one import lists. */
const MAX_WORKSPACES = 10_000;

/** Sort rows by key and keep the LAST row for a repeated key. */
function finalRows(rows: SegmentRow[]): SegmentRow[] {
  const byKey = new Map<string, SegmentRow>();
  for (const row of rows) byKey.set(row.k, row);
  return sortedByKey([...byKey.values()]);
}

/** A graph read that serves exactly the captured bytes (no segmented dispatch: the import is the incumbent read). */
function capturedGraph(capture: LegacyCapture): GraphStoreReads {
  return { readStore: async () => (capture.body === null ? null : capture.body.toString("utf8")) };
}

/** The first record still to import: every already-imported record must equal the file's same record. */
async function resumeAt(store: SegmentStore, prefix: string, imported: number, fileRecords: readonly unknown[], label: string): Promise<number> {
  if (imported > fileRecords.length) throw new Error(`${label} is shorter than its imported history; restore it from a backup`);
  let at = 0;
  for await (const row of store.scan({ prefix })) {
    if (at >= imported) break;
    if (row.k !== indexKey(prefix, at)) throw new Error(`${label}'s imported history has a gap at record ${at}; restore it from a backup`);
    if (!isDeepStrictEqual(row.v, fileRecords[at])) throw new Error(`${label} no longer matches its imported record ${at}; restore it from a backup`);
    at += 1;
  }
  if (at !== imported) throw new Error(`${label}'s imported history holds ${at} of its ${imported} recorded records; restore it from a backup`);
  return imported;
}

/** Import `wiki/graph/events.jsonl` (chain and anchor verified) into the segmented event log. */
async function importEvents(root: string): Promise<string> {
  const store = await openEventLog(root);
  const capture = await captureLegacy(root, EVENTS_FILE, MAX_EVENT_STORE_BYTES, store.counters);
  const events: EventRecord[] = await readEventsStrictFrom(diskEventReadSources(root, capturedGraph(capture)));
  await assertCaptureCurrent(root, capture, store.counters);
  const from = store.exists ? await resumeAt(store, EVENT_PREFIX, eventLogMetaOf(store).count, events, EVENTS_FILE) : 0;
  const rows: SegmentRow[] = [];
  for (let at = from; at < events.length; at += 1) {
    rows.push({ k: indexKey(EVENT_PREFIX, at), v: events[at]! });
    const binding = events[at]!.operationBinding;
    if (binding !== undefined) rows.push({ k: bindingKey(binding.mutationId, at), v: { type: events[at]!.type } });
  }
  const bound = events.some((event) => event.operationBinding !== undefined);
  await store.commit({ rows: finalRows(rows), meta: {
    schema: 1, phase: "ready", count: events.length, headDigest: events.length === 0 ? null : eventPrevHash(events.at(-1)!),
    headerVersion: bound ? EVENT_STORE_OPERATION_VERSION : EVENT_STORE_BASE_WRITE_VERSION, legacy: { ...capture.snapshot, records: events.length },
  } });
  return `${events.length - from} of ${events.length} events`;
}

/** The stored form of each record (as the relation log keeps it), for prefix comparison. */
function storedRelation(record: BoundRelationRecord, at: number): unknown {
  return relationRows(at, record.ref, record.operationBinding, undefined).find((row) => row.k === indexKey(RELATION_PREFIX, at))!.v;
}

/** The rows that import `records[from..]` with the id, content and binding indexes. */
function relationImportRows(records: readonly BoundRelationRecord[], from: number): SegmentRow[] {
  const latest = new Map<string, BoundRelationRecord>();
  for (let at = 0; at < from; at += 1) latest.set(records[at]!.ref.id, records[at]!);
  const rows: SegmentRow[] = [];
  for (let at = from; at < records.length; at += 1) {
    const record = records[at]!;
    rows.push(...relationRows(at, record.ref, record.operationBinding, latest.get(record.ref.id)?.ref));
    latest.set(record.ref.id, record);
  }
  return finalRows(rows);
}

/** Import `wiki/graph/relations.jsonl` (checksums verified) into the segmented relation log. */
async function importRelations(root: string): Promise<string> {
  const store = await openRelationLog(root);
  const capture = await captureLegacy(root, RELATIONS_FILE, MAX_RELATION_STORE_BYTES, store.counters);
  const { records } = await readRelationRecordsFrom(capturedGraph(capture));
  await assertCaptureCurrent(root, capture, store.counters);
  const from = store.exists ? await resumeAt(store, RELATION_PREFIX, relationLogMetaOf(store).count, records.map(storedRelation), RELATIONS_FILE) : 0;
  const bound = records.some((record) => record.operationBinding !== undefined);
  await store.commit({ rows: relationImportRows(records, from), meta: {
    schema: 1, phase: "ready", count: records.length, headerVersion: bound ? RELATION_STORE_OPERATION_VERSION : RELATION_STORE_BASE_WRITE_VERSION,
    legacy: { ...capture.snapshot, records: records.length },
  } });
  return `${records.length - from} of ${records.length} relations`;
}

/** Import one workspace's catalog file (full lineage replay) into its segmented catalog. */
async function importWorkspaceCatalog(root: string, workspaceId: string): Promise<number> {
  const store = await openOperationCatalog(root, workspaceId);
  const capture = await captureLegacy(root, legacyCatalogPath(root, workspaceId), MAX_CATALOG_FILE_BYTES, store.counters);
  if (capture.body === null) {
    if (store.exists || (await storeMayHoldLeaves(store.io))) throw new Error(`workspace ${workspaceId} catalog file disappeared after it was imported; restore it from a backup`);
    return 0;
  }
  const records: readonly CatalogRecord[] = parseCatalogBytes(capture.body);
  await assertCaptureCurrent(root, capture, store.counters);
  const label = `workspace ${workspaceId} catalog`;
  const from = store.exists ? await resumeAt(store, CATALOG_RECORD_PREFIX, operationCatalogMetaOf(store, root, workspaceId).count, records, label) : 0;
  const rows = records.slice(from).flatMap((record, offset) => catalogRows(from + offset, record));
  await store.commit({ rows: finalRows(rows), meta: { schema: 1, phase: "ready", workspaceId, count: records.length, legacy: { ...capture.snapshot, records: records.length } } });
  return records.length - from;
}

/** The workspace ids present under `.llmwiki/workspaces`. */
async function workspaceIds(root: string): Promise<string[]> {
  const listing = await listConfinedDirBounded(root, ".llmwiki/workspaces", MAX_WORKSPACES);
  if (listing.kind === "absent") return [];
  if (listing.kind !== "ok") throw new Error("the operation workspaces directory cannot be listed");
  return listing.entries.filter((entry) => entry.kind === "directory" && !entry.name.startsWith(".")).map((entry) => entry.name).sort();
}

/** Import every incumbent history of `root`; returns a one-line summary. */
export async function importHistories(root: string): Promise<string> {
  const events = await importEvents(root);
  const relations = await importRelations(root);
  let catalogRecords = 0;
  const workspaces = await workspaceIds(root);
  for (const workspaceId of workspaces) catalogRecords += await importWorkspaceCatalog(root, workspaceId);
  return `imported ${events}, ${relations}, ${catalogRecords} catalog records across ${workspaces.length} workspaces; incumbent files kept untouched as backups`;
}

/**
 * @file src/segments/run-writer.ts
 * @description Write one sorted run from a key-ascending row stream.
 *
 * Rows are buffered only until the current segment reaches its row or byte
 * budget; that segment is then encoded and published create-only and durably,
 * and the buffer starts over. Memory is therefore one segment, however long
 * the input. Segment names carry the run id, the segment's index and a random
 * suffix, so a name left by a crashed commit can never collide with a later
 * one. Nothing is published to readers here: the run becomes visible only
 * when a manifest naming it is published.
 */

import { randomBytes } from "node:crypto";
import { invalidWrite, MAX_SEGMENT_ROWS, type RunEntry, type SegmentEntry, type SegmentRow } from "./contracts.js";
import type { IoCounters } from "./counters.js";
import { admitRow, encodeSegment, type AdmittedRow } from "./format.js";
import type { SegmentStoreIo } from "./io.js";

/** Where a run is written and how large its segments may grow. */
export interface RunTarget {
  readonly io: SegmentStoreIo;
  readonly runId: number;
  readonly segmentBytes: number;
  readonly counters: IoCounters;
}

/** A fresh segment leaf name for segment `index` of run `runId`. */
function segmentName(runId: number, index: number): string {
  return `r${runId}-${index}-${randomBytes(4).toString("hex")}.seg`;
}

/** Encode and durably publish one segment of `rows`. */
async function publishSegment(target: RunTarget, index: number, rows: readonly AdmittedRow[]): Promise<SegmentEntry> {
  const encoded = encodeSegment(rows);
  const name = segmentName(target.runId, index);
  await target.io.writeSegment(name, encoded.bytes);
  target.counters.segmentsWritten += 1;
  target.counters.segmentBytesWritten += encoded.bytes.byteLength;
  return {
    name, minKey: encoded.minKey, maxKey: encoded.maxKey, rows: encoded.rows,
    bytes: encoded.bytes.byteLength, sha256: encoded.sha256, indexSha256: encoded.indexSha256,
  };
}

/**
 * Write `rows` (strictly ascending keys) as run `target.runId`. Returns `null`
 * for an empty stream: no segment is written. Each row is admitted (validated
 * and encoded) the moment it arrives, so later mutation of a caller's object
 * cannot change what was ordered, budgeted or written.
 */
export async function writeRun(target: RunTarget, rows: AsyncIterable<SegmentRow> | Iterable<SegmentRow>): Promise<RunEntry | null> {
  const segments: SegmentEntry[] = [];
  let buffer: AdmittedRow[] = [];
  let bytes = 0;
  for await (const incoming of rows) {
    const row = admitRow(incoming);
    if (buffer.length > 0 && !(buffer.at(-1)!.k < row.k)) invalidWrite("run rows must be in strictly ascending key order");
    if (buffer.length > 0 && (buffer.length >= MAX_SEGMENT_ROWS || bytes + row.line.byteLength > target.segmentBytes)) {
      segments.push(await publishSegment(target, segments.length, buffer));
      buffer = [];
      bytes = 0;
    }
    buffer.push(row);
    bytes += row.line.byteLength;
  }
  if (buffer.length > 0) segments.push(await publishSegment(target, segments.length, buffer));
  if (segments.length === 0) return null;
  return { id: target.runId, rows: segments.reduce((sum, entry) => sum + entry.rows, 0), segments };
}

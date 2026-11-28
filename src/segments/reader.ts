/**
 * @file src/segments/reader.ts
 * @description Bounded reads of segments and runs.
 *
 * Opening a segment checks its exact size and its block index against the
 * manifest's digest. Rows are produced one verified block at a time, so a
 * reader holds at most one block per open segment, and a run iterator holds at
 * most one open segment. Every open, byte, block and row is counted.
 */

import { corrupt, type RunEntry, type SegmentEntry, type SegmentRow } from "./contracts.js";
import type { IoCounters } from "./counters.js";
import { decodeBlock, decodeFooter, decodeTrailer, sha256Hex, TRAILER_BYTES, type SegmentFooter } from "./format.js";
import type { SegmentHandle, SegmentStoreIo } from "./io.js";

/** One open, index-verified segment. Close it when done. */
export class SegmentReader {
  private constructor(
    private readonly handle: SegmentHandle,
    readonly entry: SegmentEntry,
    readonly footer: SegmentFooter,
    private readonly counters: IoCounters,
  ) {}

  /** Open `entry`, verifying its size and block index; the handle is closed on any failure. */
  static async open(io: SegmentStoreIo, entry: SegmentEntry, counters: IoCounters): Promise<SegmentReader> {
    const handle = await io.openSegment(entry.name);
    try {
      counters.segmentsOpened += 1;
      if (handle.size !== entry.bytes) corrupt(`segment ${entry.name} is ${handle.size} bytes, the manifest says ${entry.bytes}`);
      const trailer = await handle.readAt(entry.bytes - TRAILER_BYTES, TRAILER_BYTES);
      const footerBytes = decodeTrailer(trailer, entry.bytes);
      const footerAt = entry.bytes - TRAILER_BYTES - footerBytes;
      const footer = await handle.readAt(footerAt, footerBytes);
      counters.segmentBytesRead += TRAILER_BYTES + footerBytes;
      if (sha256Hex(footer) !== entry.indexSha256) corrupt(`segment ${entry.name} block index does not match the manifest`);
      const decoded = decodeFooter(footer, footerAt);
      if (decoded.rows !== entry.rows || decoded.blocks[0]!.first !== entry.minKey || decoded.blocks.at(-1)!.last !== entry.maxKey) {
        corrupt(`segment ${entry.name} disagrees with the manifest`);
      }
      return new SegmentReader(handle, entry, decoded, counters);
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }

  /** The verified rows of block `at`. */
  async readBlock(at: number): Promise<SegmentRow[]> {
    const block = this.footer.blocks[at]!;
    const bytes = await this.handle.readAt(block.offset, block.length);
    this.counters.segmentBytesRead += block.length;
    this.counters.blocksRead += 1;
    if (sha256Hex(bytes) !== block.sha256) corrupt(`segment ${this.entry.name} block ${at} does not match its digest`);
    const rows = decodeBlock(bytes, block);
    this.counters.rowsDecoded += rows.length;
    return rows;
  }

  /** The first block that may hold a key `>= key`, or the block count when none can. */
  firstBlockFrom(key: string): number {
    const blocks = this.footer.blocks;
    let low = 0;
    let high = blocks.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (blocks[mid]!.last < key) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  /** Close the handle. */
  close(): Promise<void> {
    return this.handle.close();
  }
}

/** Where a range read starts: strictly after `after`, or at `from` and later. */
export interface RangeStart {
  readonly after?: string;
  readonly from?: string;
}

/** Whether `key` lies at or past `start`. */
function pastStart(key: string, start: RangeStart): boolean {
  if (start.after !== undefined && !(key > start.after)) return false;
  return start.from === undefined || key >= start.from;
}

/** The lowest key a range read may need: the larger of both bounds (filtering still applies both). */
function lowerBound(start: RangeStart): string {
  const after = start.after ?? "";
  const from = start.from ?? "";
  return after > from ? after : from;
}

/** Rows of one segment from `start`, one block at a time; always closes the segment. */
async function* segmentRows(io: SegmentStoreIo, entry: SegmentEntry, start: RangeStart, counters: IoCounters): AsyncGenerator<SegmentRow> {
  const reader: SegmentReader = await SegmentReader.open(io, entry, counters);
  try {
    for (let at = reader.firstBlockFrom(lowerBound(start)); at < reader.footer.blocks.length; at += 1) {
      for (const row of await reader.readBlock(at)) if (pastStart(row.k, start)) yield row;
    }
  } finally {
    await reader.close().catch(() => {});
  }
}

/** Rows of one run from `start`, one segment open at a time. */
export async function* runRows(io: SegmentStoreIo, run: RunEntry, start: RangeStart, counters: IoCounters): AsyncGenerator<SegmentRow> {
  const low = lowerBound(start);
  for (const entry of run.segments) {
    if (entry.maxKey < low) continue;
    yield* segmentRows(io, entry, start, counters);
  }
}

/** The row for exactly `key` in `run`, reading at most one segment index and one block. */
export async function runLookup(io: SegmentStoreIo, run: RunEntry, key: string, counters: IoCounters): Promise<SegmentRow | undefined> {
  const entry = run.segments.find((candidate) => candidate.minKey <= key && key <= candidate.maxKey);
  if (entry === undefined) return undefined;
  const reader: SegmentReader = await SegmentReader.open(io, entry, counters);
  try {
    const at = reader.firstBlockFrom(key);
    if (at >= reader.footer.blocks.length || reader.footer.blocks[at]!.first > key) return undefined;
    return (await reader.readBlock(at)).find((row) => row.k === key);
  } finally {
    await reader.close().catch(() => {});
  }
}

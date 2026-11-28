/**
 * @file src/compiler/batch/external-sort.ts
 * @description A STABLE, MULTI-PASS EXTERNAL MERGE SORT over a run store, so
 * the residual phases that the incumbent sorts in memory (link targets, the
 * index, the MOC) hold at most one chunk plus a FIXED number of merge heads.
 *
 * CHUNKS. Items are buffered until the buffer holds {@link SORT_CHUNK_ITEMS}
 * items or would pass {@link SORT_CHUNK_BYTES} bytes of JSON (it is spilled
 * before an item that would cross it, so a chunk holds at most that many
 * bytes, or one larger item alone); a full buffer is sorted
 * with the caller's comparator (the incumbent's, e.g. `localeCompare`) by the
 * stable `Array.prototype.sort` and spilled as the next level-0 run.
 *
 * PASSES. While a level holds more than {@link SORT_FAN_IN} runs, consecutive
 * groups of at most that many are merged into the runs of the next level; the
 * final (at most {@link SORT_FAN_IN}-way) merge is streamed to the caller. In
 * every merge a tie keeps the EARLIER run first and runs are grouped in order,
 * so the whole sort is stable with respect to the order items were added,
 * exactly as one in-memory `sort` of all of them.
 *
 * Runs are rows `<ns><level>.<run>:<pos>` (positions of
 * twelve digits). They are ordinary versioned run rows: a crash before the
 * owning phase's checkpoint leaves them invisible, and the phase sorts again.
 */

import { seqText } from "./contracts.js";
import type { BatchRun } from "./run-store.js";

/** Most items one chunk holds before it is sorted and spilled. */
export const SORT_CHUNK_ITEMS = 2_048;
/** Most JSON bytes one chunk holds before it is sorted and spilled. */
const SORT_CHUNK_BYTES = 4 * 1024 * 1024;
/** Most runs one merge reads at once. */
export const SORT_FAN_IN = 16;
/** Digits of a level and of a run number. */
const LEVEL_DIGITS = 3;
const RUN_DIGITS = 9;

/** The head of one run during a merge. */
interface RunHead<T> { readonly run: number; readonly item: T; readonly rest: AsyncGenerator<T> }

/** A stable external sort of items of type `T` under one row namespace. */
export class ExternalSorter<T> {
  private buffer: T[] = [];
  private bufferBytes = 0;
  private runs = 0;

  constructor(private readonly run: BatchRun, private readonly ns: string, private readonly compare: (a: T, b: T) => number) {}

  /** Add one item. */
  async add(item: T): Promise<void> {
    const bytes = Buffer.byteLength(JSON.stringify(item) ?? "");
    // Spill BEFORE crossing the byte bound: a chunk holds at most SORT_CHUNK_BYTES, or one larger item alone.
    if (this.buffer.length > 0 && this.bufferBytes + bytes > SORT_CHUNK_BYTES) await this.spill();
    this.buffer.push(item);
    this.bufferBytes += bytes;
    if (this.buffer.length >= SORT_CHUNK_ITEMS || this.bufferBytes >= SORT_CHUNK_BYTES) await this.spill();
  }

  /** The row prefix of run `index` at `level`. */
  private prefix(level: number, index: number): string {
    return `${this.ns}${String(level).padStart(LEVEL_DIGITS, "0")}.${String(index).padStart(RUN_DIGITS, "0")}:`;
  }

  /** Write `items` as run `index` at `level`. */
  private async write(level: number, index: number, items: AsyncIterable<T> | Iterable<T>): Promise<void> {
    let position = 0;
    for await (const item of items) await this.run.put(`${this.prefix(level, index)}${seqText(position++)}`, item);
  }

  /** Sort and spill the buffered items as the next level-0 run. */
  private async spill(): Promise<void> {
    if (this.buffer.length === 0) return;
    await this.write(0, this.runs++, this.buffer.sort(this.compare));
    this.buffer = [];
    this.bufferBytes = 0;
  }

  /** One run's items, in order. */
  private async *items(level: number, index: number): AsyncGenerator<T> {
    for await (const row of this.run.scan(this.prefix(level, index))) yield row.v as T;
  }

  /** Whether head `a` goes before head `b`: the comparator, then the earlier run. */
  private before(a: RunHead<T>, b: RunHead<T>): boolean {
    const order = this.compare(a.item, b.item);
    return order < 0 || (order === 0 && a.run < b.run);
  }

  /** The stable merge of runs `first` to `first + count - 1` at `level`. */
  private async *merge(level: number, first: number, count: number): AsyncGenerator<T> {
    const heads: RunHead<T>[] = [];
    for (let index = first; index < first + count; index += 1) {
      const rest = this.items(level, index);
      const head = await rest.next();
      if (!head.done) heads.push({ run: index, item: head.value, rest });
    }
    while (heads.length > 0) {
      let best = 0;
      for (let at = 1; at < heads.length; at += 1) if (this.before(heads[at]!, heads[best]!)) best = at;
      const head = heads[best]!;
      yield head.item;
      const next = await head.rest.next();
      if (next.done) heads.splice(best, 1);
      else heads[best] = { ...head, item: next.value };
    }
  }

  /** Every added item, sorted stably. */
  async *sorted(): AsyncGenerator<T> {
    await this.spill();
    let level = 0;
    let runs = this.runs;
    while (runs > SORT_FAN_IN) {
      let merged = 0;
      for (let first = 0; first < runs; first += SORT_FAN_IN) await this.write(level + 1, merged++, this.merge(level, first, Math.min(SORT_FAN_IN, runs - first)));
      level += 1;
      runs = merged;
    }
    yield* this.merge(level, 0, runs);
  }
}

/**
 * @file src/segments/merge.ts
 * @description The k-way, newest-wins merge of run iterators.
 *
 * Each input is a key-ascending iterator of one run, given oldest first. The
 * merge holds exactly one pending row per input (so at most one block per
 * open segment is resident), emits keys in ascending order, and for a key
 * present in several runs emits only the NEWEST run's row. Tombstones are
 * emitted or dropped as the caller asks. Ending the merge early closes every
 * input, which closes their segment handles.
 */

import type { SegmentRow } from "./contracts.js";

/** One input's iterator and its pending row. */
interface Head {
  readonly iterator: AsyncIterator<SegmentRow>;
  row: SegmentRow | undefined;
}

/** Advance `head` to its next row, or mark it exhausted. */
async function advance(head: Head): Promise<void> {
  const next = await head.iterator.next();
  head.row = next.done === true ? undefined : next.value;
}

/** The lowest pending key, or `undefined` when every input is exhausted. */
function lowestKey(heads: readonly Head[]): string | undefined {
  let lowest: string | undefined;
  for (const head of heads) if (head.row !== undefined && (lowest === undefined || head.row.k < lowest)) lowest = head.row.k;
  return lowest;
}

/** Close every input; errors while closing are ignored so the original error survives. */
async function closeAll(heads: readonly Head[]): Promise<void> {
  await Promise.all(heads.map((head) => head.iterator.return?.(undefined).catch(() => undefined)));
}

/**
 * Merge `inputs` (oldest first). The newest input holding a key wins it; a
 * winning tombstone is yielded only when `keepTombstones` is set.
 */
export async function* mergeRuns(inputs: ReadonlyArray<AsyncIterable<SegmentRow>>, keepTombstones: boolean): AsyncGenerator<SegmentRow> {
  const heads: Head[] = inputs.map((input) => ({ iterator: input[Symbol.asyncIterator](), row: undefined }));
  try {
    for (const head of heads) await advance(head);
    for (let key = lowestKey(heads); key !== undefined; key = lowestKey(heads)) {
      let winner: SegmentRow | undefined;
      for (const head of heads) {
        if (head.row?.k !== key) continue;
        winner = head.row;
        await advance(head);
      }
      if (winner !== undefined && (keepTombstones || winner.d !== 1)) yield winner;
    }
  } finally {
    await closeAll(heads);
  }
}

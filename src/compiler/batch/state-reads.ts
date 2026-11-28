/**
 * @file src/compiler/batch/state-reads.ts
 * @description The bounded reads a batch compile makes of the segmented
 * compile state (`../../cstate/contracts.ts`): one source's entry by point
 * lookup, one slug's owners by prefix scan (in incumbent insertion order),
 * and the frozen list in its stored order. The run reads ONE snapshot of the
 * store until its state-finalize phase, so every phase before it sees the
 * state the run started from, as the incumbent compile sees its draft's
 * starting state.
 */

import { compileStateMetaOf, FROZEN_ORDER_PREFIX, ORDER_PREFIX, ownersPrefix, sourceKey, type CompileStateMeta, type SourceRowV1 } from "../../cstate/contracts.js";
import { openCompileState } from "../../cstate/store.js";
import type { SegmentStore } from "../../segments/store.js";
import type { SourceState } from "../../utils/types.js";

/** One snapshot of the compile state a run reads. */
export class StateSnapshot {
  private constructor(readonly store: SegmentStore, readonly meta: CompileStateMeta) {}

  /** Open the current compile state of the project at `root`. */
  static async open(root: string): Promise<StateSnapshot> {
    const store = await openCompileState(root);
    return new StateSnapshot(store, compileStateMetaOf(store));
  }

  /** The entry of `file`, or `undefined` when the state does not hold it. */
  async source(file: string): Promise<SourceState | undefined> {
    return ((await this.store.get(sourceKey(file))) as SourceRowV1<SourceState> | undefined)?.v;
  }

  /** The owners of `slug`, in insertion order. */
  async *owners(slug: string): AsyncGenerator<string> {
    for await (const row of this.store.scan({ prefix: ownersPrefix(slug) })) yield row.v as string;
  }

  /** The frozen slugs, in their stored order. */
  async *frozen(): AsyncGenerator<string> {
    for await (const row of this.store.scan({ prefix: FROZEN_ORDER_PREFIX })) yield row.v as string;
  }

  /** Every source file, in insertion order. */
  async *sourcesInOrder(): AsyncGenerator<string> {
    for await (const row of this.store.scan({ prefix: ORDER_PREFIX })) yield row.v as string;
  }
}

/**
 * In-memory draft of the compile incremental state (`.llmwiki/state.json`).
 *
 * Today `compile` persists state INCREMENTALLY — per source, mid-pipeline — so a
 * crash between an early per-source write and the final resolution pass can leave
 * a "compiled-but-unresolved" marker on disk. {@link CompileStateDraft} buffers
 * every compile-time mutation (`setSource` / `removeSource` / `setFrozen`) in
 * memory and persists them with a SINGLE durable {@link CompileStateDraft.flush}
 * after the resolution phase. A crash before that flush simply re-runs the whole
 * compile from the prior on-disk state.
 *
 * The mutation methods delegate to the SAME pure transforms
 * ({@link applySourceState} / {@link removeSourceFrom} / {@link applyFrozenSlugs})
 * that the incremental on-disk path uses, so a draft-then-flush is structurally
 * equivalent to the per-source writes. `flush` routes through
 * {@link writeState}, inheriting its v2 typed-mirror re-sync — the persisted
 * `entities` / `frozenEntities` are re-derived from the draft's
 * `concepts` / `frozenSlugs`, never serialised stale.
 */

import {
  readState,
  writeState,
  applySourceState,
  removeSourceFrom,
  applyFrozenSlugs,
} from "../utils/state.js";
import type { SourceState, WikiState } from "../utils/types.js";

/**
 * A buffered, single-flush view of the compile incremental state. Construct via
 * {@link CompileStateDraft.load}; mutate with `setSource` / `removeSource` /
 * `setFrozen`; observe the in-memory result with `read`; persist once with
 * `flush`.
 */
export class CompileStateDraft {
  private constructor(private state: WikiState) {}

  /** Seed a draft from the current on-disk state. */
  static async load(root: string): Promise<CompileStateDraft> {
    return new CompileStateDraft(await readState(root));
  }

  /**
   * The current in-memory state; intra-compile reads use this, not disk.
   *
   * WARNING: returns the LIVE internal reference, not a copy. Treat it as
   * read-only — never mutate the returned object directly. All mutations must
   * go through {@link setSource} / {@link removeSource} / {@link setFrozen} so
   * the draft stays the single source of truth and the shared in-place
   * transforms remain the only writers.
   */
  read(): WikiState {
    return this.state;
  }

  /** Set a source's entry in memory (mirrors `updateSourceState`). */
  setSource(sourceFile: string, entry: SourceState): void {
    applySourceState(this.state, sourceFile, entry);
  }

  /** Remove a source entry in memory (mirrors `removeSourceState`). */
  removeSource(sourceFile: string): void {
    removeSourceFrom(this.state, sourceFile);
  }

  /** Replace the frozen-slug set in memory (mirrors `persistFrozenSlugs`). */
  setFrozen(slugs: Set<string>): void {
    applyFrozenSlugs(this.state, slugs);
  }

  /**
   * Persist every buffered mutation in a single durable write. Goes through
   * {@link writeState} so the v2 typed mirror is re-synced at the choke point.
   */
  async flush(root: string): Promise<void> {
    await writeState(root, this.state);
  }
}

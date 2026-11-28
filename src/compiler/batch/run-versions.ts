/**
 * @file src/compiler/batch/run-versions.ts
 * @description CRASH-SAFE VISIBILITY of a run store's rows
 * (`./run-store.ts`).
 *
 * A run publishes its buffered rows early when the buffer is full, before the
 * unit of work that wrote them is complete. A crash then must not leave those
 * rows looking committed: a redo from the last checkpoint would mistake them
 * for finished work (an owner marked affected but never queued). So every
 * physical row keeps VERSIONS:
 * - `c` is the newest version `[checkpoint, attempt, value?]` (no value: deleted);
 * - `p` is the newest COMMITTED version it replaced (if any).
 * A version is COMMITTED when its checkpoint has been published by the
 * attempt that wrote it; an ATTEMPT is one process's work on the run, and a
 * resume starts a new one. The current attempt also sees its own uncommitted
 * versions (written since its last checkpoint). A crashed attempt's
 * uncommitted versions are therefore invisible to every later attempt, and
 * the committed value beneath them survives in `p` until a later attempt
 * overwrites the row.
 */

/** One version: the checkpoint it belongs to, the attempt that wrote it, and its value (absent when it deletes). */
export type RowVersion = readonly [checkpoint: number, attempt: number, value?: unknown];

/** A physical run-store row: its newest version and the newest committed one it replaced. */
export interface VersionedRow {
  readonly c: RowVersion;
  readonly p?: RowVersion;
}

/** When each attempt began: its first checkpoint is `from + 1`. */
export interface AttemptStart { readonly a: number; readonly from: number }

/** Which versions a reader may see: those its run committed, and its own attempt's open ones. */
export class Visibility {
  constructor(readonly checkpoint: number, readonly attempts: readonly AttemptStart[], readonly current: number) {}

  /** The attempt that published checkpoint `checkpoint` (the latest attempt begun before it). */
  private ownerOf(checkpoint: number): number | undefined {
    let owner: number | undefined;
    for (const start of this.attempts) if (start.from < checkpoint) owner = start.a;
    return owner;
  }

  /** Whether `version` is committed. */
  committed(version: RowVersion): boolean {
    return version[0] <= this.checkpoint && this.ownerOf(version[0]) === version[1];
  }

  /** Whether `version` is visible to this attempt. */
  visible(version: RowVersion): boolean {
    return this.committed(version) || (version[0] === this.checkpoint + 1 && version[1] === this.current);
  }

  /** The version of `row` this attempt sees, or `undefined` when none. */
  resolve(row: VersionedRow | undefined): RowVersion | undefined {
    if (row === undefined) return undefined;
    if (this.visible(row.c)) return row.c;
    return row.p !== undefined && this.committed(row.p) ? row.p : undefined;
  }

  /** The value of `row` this attempt sees (`undefined` when absent or deleted). */
  value(row: VersionedRow | undefined): unknown {
    const version = this.resolve(row);
    return version === undefined || version.length < 3 ? undefined : version[2];
  }

  /** The physical row that records `next` (this attempt's open version) over `previous`. */
  write(previous: VersionedRow | undefined, next: RowVersion): VersionedRow {
    if (previous === undefined) return { c: next };
    const kept = this.committed(previous.c) ? previous.c : previous.p;
    return kept === undefined ? { c: next } : { c: next, p: kept };
  }
}

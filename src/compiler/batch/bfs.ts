/**
 * @file src/compiler/batch/bfs.ts
 * @description The SPILLED shared-owner walk of a batch compile: the
 * incumbent `expandSharedOwnerClosure`, with its queue, visited set and
 * affected set as run rows under one namespace, so the walk holds one queued
 * source at a time. Used by the closure (pre-extraction affected owners) and
 * by each late-discovery round (owners of newly extracted slugs).
 *
 * THE INCUMBENT ORDER: the queue starts with the seeds, then the initially
 * affected sources (each marked affected as it is queued); visiting a source
 * walks its concepts in order and each concept's owners in insertion order;
 * an owner that is neither excluded nor already affected becomes affected
 * (`<ns>a:<seq>`) and is queued. The result is the affected set in order.
 *
 * Every step's rows are written through the run's versioned buffer and the
 * walk's position is checkpointed every batch, so a crash anywhere redoes the
 * walk from its last checkpoint over exactly the committed rows.
 */

import { seqKey } from "./contracts.js";
import type { BatchRun } from "./run-store.js";
import type { StateSnapshot } from "./state-reads.js";

/** A walk's position: queue head and tail, and the affected count. */
export interface WalkPosition { head: number; tail: number; affected: number; seeded: boolean }

/** One walk: its row namespace, the exclusion rule, and its cursor key in the run's meta. */
export interface OwnerWalk {
  readonly ns: string;
  readonly excluded: (file: string) => Promise<boolean>;
  /** Seed the queue (call `queue` for seeds, `affect` for initially affected sources). */
  readonly seed: (queue: (file: string) => Promise<void>, affect: (file: string) => Promise<void>) => Promise<void>;
  /** Persist `position` with the rest of the phase cursor. */
  readonly save: (position: WalkPosition) => Promise<void>;
}

/** Queue `file`. */
async function enqueue(run: BatchRun, walk: OwnerWalk, at: WalkPosition, file: string): Promise<void> {
  await run.put(seqKey(`${walk.ns}q:`, at.tail++), file);
}

/** Mark `file` affected (in order) and queue it, unless it is excluded or already affected. */
async function affect(run: BatchRun, walk: OwnerWalk, at: WalkPosition, file: string): Promise<void> {
  if ((await walk.excluded(file)) || (await run.get(`${walk.ns}aa:${file}`)) !== undefined) return;
  await run.put(`${walk.ns}aa:${file}`, at.affected);
  await run.put(seqKey(`${walk.ns}a:`, at.affected++), file);
  await enqueue(run, walk, at, file);
}

/** Visit one queued source: its known co-owners become affected. */
async function visit(run: BatchRun, state: StateSnapshot, walk: OwnerWalk, at: WalkPosition, file: string): Promise<void> {
  if ((await run.get(`${walk.ns}v:${file}`)) !== undefined) return;
  await run.put(`${walk.ns}v:${file}`, 1);
  for (const slug of (await state.source(file))?.concepts ?? []) {
    for await (const owner of state.owners(slug)) await affect(run, walk, at, owner);
  }
}

/** Run `walk` from `position` to its fixed point; returns how many sources it marked affected. */
export async function walkOwners(run: BatchRun, state: StateSnapshot, walk: OwnerWalk, position: WalkPosition): Promise<number> {
  const at = { ...position };
  if (!at.seeded) {
    await walk.seed((file) => enqueue(run, walk, at, file), (file) => affect(run, walk, at, file));
    at.seeded = true;
    await walk.save(at);
  }
  let sinceCheckpoint = 0;
  while (at.head < at.tail) {
    await visit(run, state, walk, at, (await run.get(seqKey(`${walk.ns}q:`, at.head))) as string);
    at.head += 1;
    if ((sinceCheckpoint += 1) >= run.meta.batchSize) { await walk.save(at); sinceCheckpoint = 0; }
  }
  await walk.save(at);
  return at.affected;
}

/** A fresh walk position. */
export const freshPosition = (): WalkPosition => ({ head: 0, tail: 0, affected: 0, seeded: false });

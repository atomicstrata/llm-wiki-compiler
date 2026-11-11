/**
 * @file src/utils/lock-held-reads.ts
 * @description Share one read across a single lock-held section.
 *
 * WHY: one workflow operation, between one acquire of the project lock and its
 * one release, used to load the same effective profile four or five times (the
 * stage lookup, the lifecycle preview, the lifecycle apply, the output recovery)
 * and the same run key two or three times. Nothing inside that section writes
 * those files, and no other lock holder can, so every repeat read the same
 * bytes. {@link withLockHeldReads} opens a scope for exactly that section;
 * {@link readOncePerLockHold} serves a repeat from the first read inside it.
 *
 * THE SCOPE IS THE GUARANTEE. Outside a scope every call reads again, exactly as
 * before. A scope is opened only by the holder of the project lock, after the
 * acquire, and its memo dies with the callback, before the release: a read is
 * never reused across a lock release. A caller that may write what it reads
 * inside the scope must not route that read through here.
 *
 * A REJECTED read is forgotten, so the next call reads again and fails (or not)
 * on its own; a value `keep` declines (an absent run key) is forgotten too.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

/** One lock-held section's reads, by key. */
type LockHeldMemo = Map<string, Promise<unknown>>;

const scope = new AsyncLocalStorage<LockHeldMemo>();

/**
 * Run `body` as one lock-held section. Call only while holding the project lock,
 * and only around work that releases it after `body` settles.
 *
 * @param body - The section; reads routed through {@link readOncePerLockHold} inside it are shared.
 * @returns What `body` returns.
 */
export function withLockHeldReads<T>(body: () => Promise<T>): Promise<T> {
  return scope.run(new Map(), body);
}

/**
 * `read()`, or inside a lock-held section the first `read()` made under the same
 * `kind` and project `root`.
 *
 * @param kind - What is read (one name per reader).
 * @param root - The project root the read is about.
 * @param read - The read itself.
 * @param keep - Whether a resolved value may serve later calls; others read again.
 * @returns The read's value.
 */
export function readOncePerLockHold<T>(kind: string, root: string, read: () => Promise<T>,
  keep: (value: T) => boolean = () => true): Promise<T> {
  const memo = scope.getStore();
  if (memo === undefined) return read();
  const key = `${kind}\0${path.resolve(root)}`;
  const shared = memo.get(key) as Promise<T> | undefined;
  if (shared !== undefined) return shared;
  const first = read();
  memo.set(key, first);
  const forget = (): void => { if (memo.get(key) === first) memo.delete(key); };
  first.then((value) => { if (!keep(value)) forget(); }, forget);
  return first;
}

/** Whether the caller runs inside a lock-held section. */
export function inLockHeldSection(): boolean {
  return scope.getStore() !== undefined;
}

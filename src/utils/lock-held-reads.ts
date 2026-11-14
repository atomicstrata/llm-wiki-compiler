/** Share one read across a single lock-held section. */

import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

type LockHeldMemo = Map<string, Promise<unknown>>;

const scope = new AsyncLocalStorage<LockHeldMemo>();

/** Run `body` as one lock-held section. */
export function withLockHeldReads<T>(body: () => Promise<T>): Promise<T> {
  return scope.run(new Map(), body);
}

/** `read()`, or inside a lock-held section the first `read()` made under the same `kind` and project `root`. */
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

/** Forget every read the current lock-held section shared; this process just wrote a file. */
export function forgetLockHeldReads(): void {
  scope.getStore()?.clear();
}

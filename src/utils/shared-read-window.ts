/** The window that src/storage/shared-page-reads.ts shares confined page reads within, keyed by resolved path, and the hook writers use to drop a path's shared read after writing it. */

import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

const window = new AsyncLocalStorage<Map<string, unknown>>();

/** Run `steps` inside a fresh window. */
export function runInSharedReadWindow<T>(steps: () => Promise<T>): Promise<T> {
  return window.run(new Map(), steps);
}

/** The current window's entries by resolved path, or `undefined` outside a window. */
export function sharedReadEntries<Entry>(): Map<string, Entry> | undefined {
  return window.getStore() as Map<string, Entry> | undefined;
}

/** The window key for `file`. */
export function sharedReadKey(file: string): string {
  return path.resolve(file);
}

/** Drop the current window's shared read of `file`, after this process wrote it, so the next ask reads the file again. */
export function forgetSharedRead(file: string): void {
  window.getStore()?.delete(sharedReadKey(file));
}

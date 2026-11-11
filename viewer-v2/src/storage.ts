/**
 * Per-browser conveniences in `localStorage`: recent pages and the last-visit
 * stamp. Reading the `localStorage` property itself throws in some private
 * modes and sandboxed frames, writing can throw when storage is full, and a
 * stored value can be junk from an older client; every one of those just
 * means "nothing stored", never an error the reader sees. Callers pass the
 * store, so tests hand in a plain object.
 */

/** The two methods the conveniences need. */
export type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

/** `localStorage`, or undefined where it is missing or reading it throws. */
export function safeLocalStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** The parsed JSON under `key`, or null when absent, unreadable or not JSON. */
export function readStored(store: KeyValueStore | undefined, key: string): unknown {
  try {
    return JSON.parse(store?.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

/** Store `value` as JSON under `key`; a failure only costs the convenience. */
export function writeStored(store: KeyValueStore | undefined, key: string, value: unknown): void {
  try {
    store?.setItem(key, JSON.stringify(value));
  } catch {
    // Blocked or full storage: the convenience is simply unavailable.
  }
}

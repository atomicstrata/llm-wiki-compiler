/**
 * `localStorage`, guarded. Reading the property itself throws in some private
 * modes and sandboxed frames, so every per-browser convenience (recent pages,
 * the last-visit stamp) asks here and treats undefined as "nothing stored".
 */

/** `localStorage`, or undefined where it is missing or reading it throws. */
export function safeLocalStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

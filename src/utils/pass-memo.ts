/**
 * @file Share one read among every caller of a pass.
 *
 * A PASS is a stretch of work that reads before it writes: a store pass under
 * one hold of the project lock, a compile link pass, a lint run, a trust plan.
 * Wrap each read the pass repeats in {@link once} (one question) or
 * {@link oncePer} (one question per distinct argument), and every caller after
 * the first shares the first caller's promise, its rejection included. Build
 * the wrappers at the start of the pass and drop them with it: a wrapper kept
 * past a write answers with what was there before. See
 * `preparations/pass-reads.ts` for a store's use of the pattern.
 */

/** Ask `read` at most once; every caller shares the one answer. */
export function once<R>(read: () => Promise<R>): () => Promise<R> {
  let answer: Promise<R> | undefined;
  return () => (answer ??= read());
}

/** A key read's answer, as each store's key reader gives it. */
type KeyRead<E> = { status: "ok"; keyEpochId: E } | { status: "absent" } | { status: "unavailable" };

/** The key's status and epoch from `readKey`, with the key bytes left behind. */
export function epochOnly<E>(readKey: () => Promise<KeyRead<E>>): () => Promise<KeyRead<E>> {
  return async () => {
    const key = await readKey();
    // A NEW OBJECT, BY NAME: the ok answer also carries the key bytes.
    return key.status === "ok" ? { status: "ok", keyEpochId: key.keyEpochId } : key;
  };
}

/** Ask `read` at most once per distinct `key`; callers with the same key share the answer. */
export function oncePer<A extends unknown[], R>(key: (...args: A) => string, read: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  const answers = new Map<string, Promise<R>>();
  return (...args) => {
    const id = key(...args);
    let answer = answers.get(id);
    if (answer === undefined) answers.set(id, answer = read(...args));
    return answer;
  };
}

/**
 * @file The two memo shapes a store's pass reads are built from.
 *
 * A PASS reads a store under one hold of the project lock before it writes.
 * Each store's `pass-reads.ts` builds its reads from these: a question asked
 * once per pass (the key), or once per distinct argument (a manifest, a run).
 * Every caller in the pass shares the first caller's answer. See
 * `preparations/pass-reads.ts` for the pattern.
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

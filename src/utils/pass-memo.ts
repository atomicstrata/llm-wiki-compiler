/** A PASS is a stretch of work that reads before it writes: a store pass under one hold of the project lock, a compile link pass, a lint run, a trust plan. */

/** Ask `read` at most once; every caller shares the one answer. */
export function once<R>(read: () => Promise<R>): () => Promise<R> {
  let answer: Promise<R> | undefined;
  return () => (answer ??= read());
}

type KeyRead<E> = { status: "ok"; keyEpochId: E } | { status: "absent" } | { status: "unavailable" };

/** The key's status and epoch from `readKey`, with the key bytes left behind. */
export function epochOnly<E>(readKey: () => Promise<KeyRead<E>>): () => Promise<KeyRead<E>> {
  return async () => {
    const key = await readKey();
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

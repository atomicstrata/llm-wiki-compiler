/**
 * A small hook for loading data that depends on the current route.
 *
 * It reloads when `key` changes. A result is only ever reported for the key it
 * was loaded for: the moment the key changes the hook reports `loading`, and a
 * response that arrives after the key has moved on is ignored. A view therefore
 * never shows one route's data under another route.
 */
import { useEffect, useState } from "react";

/** The state of one load. */
export type AsyncState<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: T };

const LOADING = { status: "loading" } as const;

/** Run `load` whenever `key` changes and report its state for that key. */
export function useAsync<T>(load: () => Promise<T>, key: string): AsyncState<T> {
  const [settled, setSettled] = useState<{ key: string; state: AsyncState<T> } | null>(null);
  useEffect(() => {
    let isCurrent = true;
    const settle = (state: AsyncState<T>): void => {
      if (isCurrent) setSettled({ key, state });
    };
    load().then(
      (data) => settle({ status: "ready", data }),
      (error: unknown) => settle({ status: "error", message: error instanceof Error ? error.message : String(error) }),
    );
    return () => { isCurrent = false; };
    // `load` is recreated on every render; `key` is what identifies the request.
  }, [key]);
  return settled?.key === key ? settled.state : LOADING;
}

/**
 * A small hook for loading data that depends on the current route.
 *
 * It reloads when `key` changes and ignores a response that arrives after the
 * key has moved on, so a slow request can never overwrite a newer view.
 */
import { useEffect, useState } from "react";

/** The state of one load. */
export type AsyncState<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: T };

/** Run `load` whenever `key` changes and report its state. */
export function useAsync<T>(load: () => Promise<T>, key: string): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: "loading" });
  useEffect(() => {
    let isCurrent = true;
    setState({ status: "loading" });
    load().then(
      (data) => { if (isCurrent) setState({ status: "ready", data }); },
      (error: unknown) => {
        if (isCurrent) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => { isCurrent = false; };
    // `load` is recreated on every render; `key` is what identifies the request.
  }, [key]);
  return state;
}

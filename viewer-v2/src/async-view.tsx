/**
 * Renders the loading and error states shared by every data-backed view, and
 * hands the loaded data to its child once it is ready.
 */
import type { ReactNode } from "react";
import type { AsyncState } from "./use-async";

interface AsyncViewProps<T> {
  state: AsyncState<T>;
  children: (data: T) => ReactNode;
}

/** Show a status line until `state` is ready, then render `children`. */
export function AsyncView<T>({ state, children }: AsyncViewProps<T>): ReactNode {
  if (state.status === "loading") return <p className="py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>;
  if (state.status === "error") return <p role="alert" className="mx-auto max-w-3xl rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-400">{state.message}</p>;
  return children(state.data);
}

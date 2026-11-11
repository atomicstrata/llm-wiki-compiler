/**
 * Renders the loading and error states shared by every data-backed view, and
 * hands the loaded data to its child once it is ready.
 */
import type { ReactNode } from "react";
import { Notice } from "./components";
import type { AsyncState } from "./use-async";

interface AsyncViewProps<T> {
  state: AsyncState<T>;
  /** What is loading, when "Loading…" says too little. */
  loading?: string;
  /** What the reader sees on failure instead of the raw request error. */
  error?: string;
  children: (data: T) => ReactNode;
}

/** Show a status line until `state` is ready, then render `children`. */
export function AsyncView<T>({ state, loading = "Loading…", error, children }: AsyncViewProps<T>): ReactNode {
  if (state.status === "loading") return <p role="status" className="py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">{loading}</p>;
  if (state.status === "error") return <div className="mx-auto max-w-3xl"><Notice tone="red" alert>{error ?? state.message}</Notice></div>;
  return children(state.data);
}
